import Foundation
@preconcurrency import AVFoundation
import Combine

/// Audio configuration constants
private enum AudioConfig {
    static let sampleRate: Double = 24000 // 24kHz for OpenAI Realtime API
    static let channels: UInt32 = 1 // Mono
    static let bufferDurationMs: Double = 100 // 100ms buffer chunks
}

/// Service for audio capture and playback using AVAudioEngine
/// Follows Apple's correct AVAudioEngine setup order:
/// 1. Setup session -> 2. Create engine + nodes -> 3. Attach nodes
/// 4. Install tap -> 5. Connect nodes -> 6. Prepare -> 7. Start -> 8. Play
class AudioService: ObservableObject {
    static let shared = AudioService()
    
    // MARK: - Published Properties for UI (updated from audio queue)
    
    @Published private(set) var inputLevel: Float = 0
    @Published private(set) var outputLevel: Float = 0
    @Published private(set) var waveformSamples: [Float] = Array(repeating: 0, count: 64)
    
    // MARK: - Private Properties
    
    private var audioEngine: AVAudioEngine?
    private var inputNode: AVAudioInputNode?
    private var playerNode: AVAudioPlayerNode?
    private var mixerNode: AVAudioMixerNode?
    
    private var apiFormat: AVAudioFormat?
    private var formatConverter: AVAudioConverter?
    private var hardwareFormat: AVAudioFormat?
    
    private var isRecording = false
    private var isPlaying = false
    private var isEngineRunning = false
    
    // Audio capture callback - called from audio processing queue
    var onAudioData: ((Data) -> Void)?
    
    // Serial queue for thread-safe UI updates (NOT main thread)
    private let audioProcessingQueue = DispatchQueue(label: "com.kordn8.shadow.audio.processing", qos: .userInteractive)
    
    private init() {}
    
    // MARK: - Audio Session Setup
    
    /// Setup audio session for voice chat
    private func setupAudioSession() throws {
        let audioSession = AVAudioSession.sharedInstance()
        
        try audioSession.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP]
        )
        
        try audioSession.setPreferredSampleRate(AudioConfig.sampleRate)
        try audioSession.setPreferredIOBufferDuration(AudioConfig.bufferDurationMs / 1000.0)
        
        try audioSession.setActive(true)
    }
    
    // MARK: - Step 1 & 2 & 3: Create Engine and Attach Nodes (NO start, NO connect, NO tap)
    
    /// Create audio engine and attach nodes only - does NOT start engine
    private func createEngineAndAttachNodes() throws {
        // Stop and clear existing engine
        if let engine = audioEngine {
            if engine.isRunning {
                engine.stop()
            }
            audioEngine = nil
        }
        
        audioEngine = AVAudioEngine()
        guard let engine = audioEngine else {
            throw AudioError.engineSetupFailed
        }
        
        // Get input node (always exists on engine)
        inputNode = engine.inputNode
        
        // Create player and mixer nodes
        playerNode = AVAudioPlayerNode()
        mixerNode = AVAudioMixerNode()
        
        guard let player = playerNode, let mixer = mixerNode else {
            throw AudioError.engineSetupFailed
        }
        
        // Create API format: 24kHz, 16-bit PCM, mono
        apiFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: AudioConfig.sampleRate,
            channels: AudioConfig.channels,
            interleaved: true
        )
        
        guard apiFormat != nil else {
            throw AudioError.invalidFormat
        }
        
        // ONLY attach nodes here - do NOT connect yet
        engine.attach(player)
        engine.attach(mixer)
        
        print("✅ AudioService: Engine created, nodes attached")
    }
    
    // MARK: - Step 4, 5, 6, 7: Install Tap, Connect, Prepare, Start
    
    /// Start engine with correct order: tap -> connect -> prepare -> start
    private func startEngineWithTap() throws {
        guard let engine = audioEngine,
              let input = inputNode,
              let player = playerNode,
              let mixer = mixerNode,
              let apiFormat = apiFormat else {
            throw AudioError.engineSetupFailed
        }
        
        // Get hardware format from input node
        hardwareFormat = input.inputFormat(forBus: 0)
        
        guard let hwFormat = hardwareFormat, hwFormat.sampleRate > 0 else {
            throw AudioError.invalidFormat
        }
        
        print("📊 AudioService: Hardware format - \(hwFormat.sampleRate)Hz, \(hwFormat.channelCount) ch")
        
        // Create format converter if needed
        if hwFormat.sampleRate != apiFormat.sampleRate || hwFormat.channelCount != apiFormat.channelCount {
            formatConverter = AVAudioConverter(from: hwFormat, to: apiFormat)
            print("🔄 AudioService: Format converter created")
        }
        
        // Calculate buffer size
        let bufferSize = AVAudioFrameCount(hwFormat.sampleRate * (AudioConfig.bufferDurationMs / 1000.0))
        
        // STEP 4: Install input tap BEFORE starting engine
        let converter = formatConverter
        let targetFormat = apiFormat
        
        input.installTap(onBus: 0, bufferSize: bufferSize, format: hwFormat) { [weak self] buffer, _ in
            // ⚠️ CRITICAL: This runs on real-time audio thread
            // NO async, NO Task, NO MainActor - process synchronously
            self?.processAudioBufferOnAudioThread(buffer, converter: converter, targetFormat: targetFormat)
        }
        
        print("🎤 AudioService: Input tap installed")
        
        // STEP 5: Connect nodes AFTER tap installed
        let playbackFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: AudioConfig.sampleRate,
            channels: AudioConfig.channels,
            interleaved: false
        )!
        
        engine.connect(player, to: mixer, format: playbackFormat)
        engine.connect(mixer, to: engine.mainMixerNode, format: playbackFormat)
        
        print("🔗 AudioService: Nodes connected")
        
        // STEP 6: Prepare engine
        engine.prepare()
        
        // STEP 7: Start engine
        try engine.start()
        isEngineRunning = true
        
        print("▶️ AudioService: Engine started")
    }
    
    // MARK: - Audio Processing (runs on audio thread - NO async!)
    
    /// Process audio buffer synchronously on audio thread
    /// ⚠️ This must NOT use async, Task, or MainActor
    private nonisolated func processAudioBufferOnAudioThread(
        _ buffer: AVAudioPCMBuffer,
        converter: AVAudioConverter?,
        targetFormat: AVAudioFormat
    ) {
        guard buffer.frameLength > 0 else { return }
        
        // Calculate levels and extract waveform on audio thread
        var inputLevelValue: Float = 0
        var waveformData: [Float] = []
        var audioData: Data?
        
        // Process based on buffer format
        if let floatData = buffer.floatChannelData {
            // Float32 format
            var sum: Float = 0
            let frameLength = Int(buffer.frameLength)
            
            for i in 0..<frameLength {
                let sample = floatData[0][i]
                sum += sample * sample
            }
            
            let rms = sqrt(sum / Float(frameLength))
            inputLevelValue = min(1.0, rms * 3)
            
            // Extract waveform samples
            let sampleCount = 64
            let step = max(1, frameLength / sampleCount)
            for i in stride(from: 0, to: min(frameLength, sampleCount * step), by: step) {
                waveformData.append(abs(floatData[0][i]))
            }
            while waveformData.count < sampleCount {
                waveformData.append(0)
            }
        }
        
        // Convert to API format
        if let converter = converter {
            let ratio = targetFormat.sampleRate / buffer.format.sampleRate
            let outputFrameCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 100
            
            guard let convertedBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputFrameCapacity) else {
                sendUIUpdates(level: inputLevelValue, waveform: waveformData, audio: nil)
                return
            }
            
            var error: NSError?
            var inputProvided = false
            
            converter.convert(to: convertedBuffer, error: &error) { _, outStatus in
                if !inputProvided {
                    inputProvided = true
                    outStatus.pointee = .haveData
                    return buffer
                } else {
                    outStatus.pointee = .noDataNow
                    return nil
                }
            }
            
            if error == nil, convertedBuffer.frameLength > 0, let channelData = convertedBuffer.int16ChannelData {
                let frameLength = Int(convertedBuffer.frameLength)
                audioData = Data(bytes: channelData.pointee, count: frameLength * MemoryLayout<Int16>.size)
                
                // Update waveform from converted buffer
                waveformData = []
                let sampleCount = 64
                let step = max(1, frameLength / sampleCount)
                for i in stride(from: 0, to: min(frameLength, sampleCount * step), by: step) {
                    let normalizedSample = Float(channelData.pointee[i]) / Float(Int16.max)
                    waveformData.append(abs(normalizedSample))
                }
                while waveformData.count < sampleCount {
                    waveformData.append(0)
                }
            }
        } else if let int16Data = buffer.int16ChannelData {
            // No conversion needed - already in target format
            let frameLength = Int(buffer.frameLength)
            audioData = Data(bytes: int16Data.pointee, count: frameLength * MemoryLayout<Int16>.size)
            
            // Calculate level from int16 data
            var sum: Float = 0
            for i in 0..<frameLength {
                let sample = Float(int16Data[0][i]) / Float(Int16.max)
                sum += sample * sample
            }
            let rms = sqrt(sum / Float(frameLength))
            inputLevelValue = min(1.0, rms * 3)
            
            // Extract waveform
            waveformData = []
            let sampleCount = 64
            let step = max(1, frameLength / sampleCount)
            for i in stride(from: 0, to: min(frameLength, sampleCount * step), by: step) {
                let normalizedSample = Float(int16Data[0][i]) / Float(Int16.max)
                waveformData.append(abs(normalizedSample))
            }
            while waveformData.count < sampleCount {
                waveformData.append(0)
            }
        }
        
        // Send updates via processing queue (NOT main thread for audio callback)
        sendUIUpdates(level: inputLevelValue, waveform: waveformData, audio: audioData)
    }
    
    /// Send UI updates from audio processing queue to main thread
    private nonisolated func sendUIUpdates(level: Float, waveform: [Float], audio: Data?) {
        // Use DispatchQueue.main.async for UI updates - this is safe from audio thread
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.inputLevel = level
            self.waveformSamples = waveform
            
            // Call audio callback
            if let audioData = audio {
                self.onAudioData?(audioData)
            }
        }
    }
    
    // MARK: - Public Recording API
    
    /// Request microphone permission and start recording
    @MainActor
    func startRecording() async throws {
        guard !isRecording else { return }
        
        // Request microphone permission
        let granted = await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
        
        guard granted else {
            throw AudioError.permissionDenied
        }
        
        // Step 1: Setup audio session
        try setupAudioSession()
        
        // Step 2 & 3: Create engine and attach nodes
        try createEngineAndAttachNodes()
        
        // Step 4, 5, 6, 7: Install tap, connect, prepare, start
        try startEngineWithTap()
        
        isRecording = true
        print("🎙️ AudioService: Recording started")
    }
    
    /// Stop recording
    @MainActor
    func stopRecording() {
        guard isRecording else { return }
        
        isRecording = false
        
        // Remove tap first
        inputNode?.removeTap(onBus: 0)
        
        // Reset UI state
        inputLevel = 0
        waveformSamples = Array(repeating: 0, count: 64)
        
        print("⏹️ AudioService: Recording stopped")
    }
    
    // MARK: - Audio Playback
    
    /// Start audio playback (Step 8)
    @MainActor
    func startPlayback() throws {
        guard !isPlaying else { return }
        
        // Ensure engine is setup
        if audioEngine == nil {
            try setupAudioSession()
            try createEngineAndAttachNodes()
            
            // For playback-only, we still need to connect nodes
            guard let engine = audioEngine,
                  let player = playerNode,
                  let mixer = mixerNode else {
                throw AudioError.engineSetupFailed
            }
            
            let playbackFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: AudioConfig.sampleRate,
                channels: AudioConfig.channels,
                interleaved: false
            )!
            
            engine.connect(player, to: mixer, format: playbackFormat)
            engine.connect(mixer, to: engine.mainMixerNode, format: playbackFormat)
            
            engine.prepare()
            try engine.start()
            isEngineRunning = true
        }
        
        guard let player = playerNode else {
            throw AudioError.engineSetupFailed
        }
        
        // VALIDATION: Verify player node is connected before playing
        guard player.outputFormat(forBus: 0).sampleRate > 0 else {
            print("❌ AudioService: PlayerNode not connected - cannot play")
            throw AudioError.playbackFailed
        }
        
        isPlaying = true
        player.play()
        
        print("🔊 AudioService: Playback started")
    }
    
    /// Play PCM16 audio data (24kHz, mono)
    @MainActor
    func playAudio(_ audioData: Data) {
        guard isPlaying, let player = playerNode else { return }
        
        // Verify player is still connected
        guard player.outputFormat(forBus: 0).sampleRate > 0 else {
            print("⚠️ AudioService: PlayerNode disconnected, skipping audio")
            return
        }
        
        // Convert Data to AVAudioPCMBuffer
        guard let buffer = createPlaybackBuffer(from: audioData) else { return }
        
        // Update output level
        updateOutputLevel(from: buffer)
        
        // Schedule buffer for playback
        player.scheduleBuffer(buffer)
    }
    
    /// Create playback buffer from PCM16 data
    private func createPlaybackBuffer(from data: Data) -> AVAudioPCMBuffer? {
        let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: AudioConfig.sampleRate,
            channels: AudioConfig.channels,
            interleaved: false
        )!
        
        let frameCount = data.count / MemoryLayout<Int16>.size
        guard frameCount > 0 else { return nil }
        
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCount)) else {
            return nil
        }
        
        buffer.frameLength = AVAudioFrameCount(frameCount)
        
        guard let floatData = buffer.floatChannelData else { return nil }
        
        data.withUnsafeBytes { bytes in
            let int16Pointer = bytes.bindMemory(to: Int16.self)
            for i in 0..<frameCount {
                floatData[0][i] = Float(int16Pointer[i]) / Float(Int16.max)
            }
        }
        
        return buffer
    }
    
    /// Stop audio playback
    @MainActor
    func stopPlayback() {
        guard isPlaying else { return }
        
        isPlaying = false
        playerNode?.stop()
        outputLevel = 0
        
        print("⏹️ AudioService: Playback stopped")
    }
    
    // MARK: - Level Updates
    
    private func updateOutputLevel(from buffer: AVAudioPCMBuffer) {
        guard let channelData = buffer.floatChannelData else { return }
        
        var sum: Float = 0
        let frameLength = Int(buffer.frameLength)
        for i in 0..<frameLength {
            let sample = channelData[0][i]
            sum += sample * sample
        }
        let rms = sqrt(sum / Float(frameLength))
        outputLevel = min(1.0, rms * 3)
    }
    
    // MARK: - Cleanup
    
    @MainActor
    func stopAll() {
        stopRecording()
        stopPlayback()
        
        if let engine = audioEngine {
            if engine.isRunning {
                engine.stop()
            }
        }
        
        audioEngine = nil
        inputNode = nil
        playerNode = nil
        mixerNode = nil
        formatConverter = nil
        hardwareFormat = nil
        isEngineRunning = false
        
        inputLevel = 0
        outputLevel = 0
        waveformSamples = Array(repeating: 0, count: 64)
        
        try? AVAudioSession.sharedInstance().setActive(false)
        
        print("🧹 AudioService: All stopped and cleaned up")
    }
    
    // MARK: - Status
    
    @MainActor
    func isCurrentlyRecording() -> Bool {
        return isRecording
    }
    
    @MainActor
    func isCurrentlyPlaying() -> Bool {
        return isPlaying
    }
}

// MARK: - Audio Error Types

enum AudioError: Error, LocalizedError {
    case permissionDenied
    case engineSetupFailed
    case invalidFormat
    case alreadyRecording
    case alreadyPlaying
    case playbackFailed
    
    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Microphone permission denied"
        case .engineSetupFailed:
            return "Failed to setup audio engine"
        case .invalidFormat:
            return "Invalid audio format"
        case .alreadyRecording:
            return "Already recording"
        case .alreadyPlaying:
            return "Already playing"
        case .playbackFailed:
            return "Playback failed - player node not connected"
        }
    }
}
