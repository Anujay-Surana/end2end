import Foundation
@preconcurrency import AVFoundation
import Combine

/// Audio configuration constants
private enum AudioConfig {
    static let sampleRate: Double = 24000 // 24kHz for OpenAI Realtime API
    static let channels: UInt32 = 1 // Mono
    // Temporarily use a larger buffer to ensure tap stability while debugging capture
    static let bufferDurationMs: Double = 50 // ~50ms chunks
}

/// Service for audio capture and playback using AVAudioEngine
/// Follows Apple's correct AVAudioEngine setup order:
/// 1. Setup session -> 2. Create engine + nodes -> 3. Attach nodes
/// 4. Install tap -> 5. Connect nodes -> 6. Prepare -> 7. Start -> 8. Play
/// Note: @unchecked Sendable is required for DispatchQueue.main.async callbacks from audio thread
class AudioService: ObservableObject, @unchecked Sendable {
    static let shared = AudioService()
    
    // MARK: - Published Properties for UI (updated from audio queue)
    
    @Published private(set) var inputLevel: Float = 0
    @Published private(set) var outputLevel: Float = 0
    @Published private(set) var waveformSamples: [Float] = Array(repeating: 0, count: 64)
    
    // MARK: - Private Properties
    
    private var audioEngine: AVAudioEngine?
    private var inputNode: AVAudioInputNode?
    private var playerNode: AVAudioPlayerNode?
    // NOTE: Removed custom mixerNode - connect directly to mainMixerNode instead
    
    private var apiFormat: AVAudioFormat?
    private var formatConverter: AVAudioConverter?
    private var hardwareFormat: AVAudioFormat?
    
    private var isRecording = false
    private var isPlaying = false
    private var isEngineRunning = false
    private var tapLogCount = 0
    private var tapTotalCount = 0
    private var firstNonZeroRmsLogged = false
    private var tapDebugTimer: DispatchSourceTimer?
    private var tapDebugTicks = 0
    
    // Audio capture callback - called from audio processing queue
    var onAudioData: ((Data) -> Void)?
    
    private init() {}
    
    // MARK: - Audio Session Setup
    
    /// Setup audio session for voice chat with echo cancellation
    private func setupAudioSession() throws {
        let audioSession = AVAudioSession.sharedInstance()
        
        // Use voiceChat mode for hardware echo cancellation, noise suppression, and AGC
        // Include all Bluetooth and AirPlay options for best echo cancellation on speaker
        try audioSession.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: []
        )
        
        try audioSession.setPreferredSampleRate(AudioConfig.sampleRate)
        try audioSession.setPreferredIOBufferDuration(AudioConfig.bufferDurationMs / 1000.0)
        
        try audioSession.setActive(true)
    }
    
    // MARK: - Volume Control (for echo attenuation)
    
    /// Set output volume (0.0 to 1.0) - used for echo attenuation during user speech
    func setOutputVolume(_ volume: Float) {
        audioEngine?.mainMixerNode.outputVolume = max(0.0, min(1.0, volume))
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
        
        // Create player node only (no custom mixer needed)
        playerNode = AVAudioPlayerNode()
        
        guard let player = playerNode else {
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
        
        // ONLY attach playerNode - connect directly to mainMixerNode later
        engine.attach(player)
        
        print("✅ AudioService: Engine created, playerNode attached")
    }
    
    // MARK: - Step 4, 5, 6, 7: Install Tap, Connect, Prepare, Start
    
    /// Start engine with correct order: tap -> connect -> prepare -> start
    private func startEngineWithTap() throws {
        guard let engine = audioEngine,
              let input = inputNode,
              let player = playerNode,
              let apiFormat = apiFormat else {
            throw AudioError.engineSetupFailed
        }
        
        // Enable hardware voice processing (AEC/AGC/NS) if available
        if input.isVoiceProcessingEnabled == false {
            do {
                try input.setVoiceProcessingEnabled(true)
                print("✅ AudioService: Voice processing enabled on input node")
            } catch {
                print("⚠️ AudioService: Voice processing not available: \(error.localizedDescription)")
            }
        }
        
        let route = AVAudioSession.sharedInstance().currentRoute
        let outputs = route.outputs.map { $0.portType.rawValue }.joined(separator: ",")
        let inputs = route.inputs.map { $0.portType.rawValue }.joined(separator: ",")
        print("📡 AudioService: Current route inputs=\(inputs) outputs=\(outputs) voiceProc=\(input.isVoiceProcessingEnabled)")
        
        // Ensure volumes are at unity
        input.volume = 1.0
        engine.mainMixerNode.outputVolume = 1.0
        
        // FIX #3: Get hardware format with retry logic for Bluetooth/delayed devices
        var hwFormat: AVAudioFormat?
        for attempt in 1...5 {
            let format = input.inputFormat(forBus: 0)
            if format.sampleRate > 0 && format.channelCount > 0 {
                hwFormat = format
                break
            }
            print("⏳ AudioService: Waiting for valid input format (attempt \(attempt)/5)")
            usleep(50000) // 50ms delay
        }
        
        guard let hardwareFormat = hwFormat, hardwareFormat.sampleRate > 0 else {
            print("❌ AudioService: Failed to get valid hardware format after retries")
            throw AudioError.invalidFormat
        }
        
        self.hardwareFormat = hardwareFormat
        print("📊 AudioService: Hardware format - \(hardwareFormat.sampleRate)Hz, \(hardwareFormat.channelCount) ch, \(hardwareFormat.commonFormat.rawValue)")
        
        // Create format converter (hardware is always Float32, we need PCM16)
        formatConverter = AVAudioConverter(from: hardwareFormat, to: apiFormat)
        if formatConverter != nil {
            print("🔄 AudioService: Format converter created: \(hardwareFormat.sampleRate)Hz Float32 → \(apiFormat.sampleRate)Hz PCM16")
        } else {
            print("⚠️ AudioService: Failed to create format converter")
        }
        
        // Calculate buffer size
        let bufferSize = AVAudioFrameCount(hardwareFormat.sampleRate * (AudioConfig.bufferDurationMs / 1000.0))
        
        // STEP 4: Install input tap BEFORE starting engine
        let converter = formatConverter
        let targetFormat = apiFormat
        
        input.installTap(onBus: 0, bufferSize: bufferSize, format: hardwareFormat) { [weak self] buffer, _ in
            // ⚠️ CRITICAL: This runs on real-time audio thread
            // NO async, NO Task, NO MainActor - process synchronously
            self?.processAudioBufferOnAudioThread(buffer, converter: converter, targetFormat: targetFormat)
        }
        
        print("🎤 AudioService: Input tap installed")
        
        // STEP 5: Connect nodes AFTER tap installed
        // FIX #1: Connect playerNode directly to mainMixerNode (no custom mixer)
        let playbackFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: AudioConfig.sampleRate,
            channels: AudioConfig.channels,
            interleaved: false
        )!
        
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        
        print("🔗 AudioService: PlayerNode connected directly to mainMixerNode")
        
        // STEP 6: Prepare engine
        engine.prepare()
        
        // STEP 7: Start engine
        try engine.start()
        isEngineRunning = true
        
        print("▶️ AudioService: Engine started (isRunning=\(engine.isRunning))")
    }
    
    // MARK: - Audio Processing (runs on audio thread - NO async!)
    
    /// Process audio buffer synchronously on audio thread
    /// ⚠️ This must NOT use async, Task, or MainActor
    /// FIX #2: Always expect Float32 from hardware - that's what iOS always provides
    private nonisolated func processAudioBufferOnAudioThread(
        _ buffer: AVAudioPCMBuffer,
        converter: AVAudioConverter?,
        targetFormat: AVAudioFormat
    ) {
        guard buffer.frameLength > 0 else { return }
        
        // Temporary debug: log first few tap frame lengths to confirm capture
        tapTotalCount += 1
        if tapLogCount < 5 {
            tapLogCount += 1
            print("🎛️ AudioService: tap frameLength=\(buffer.frameLength)")
        }
        
        // Hardware audio is ALWAYS Float32 - no need for dual-format handling
        guard let floatData = buffer.floatChannelData else {
            print("⚠️ AudioService: Unexpected buffer format - no Float32 data")
            return
        }
        
        let frameLength = Int(buffer.frameLength)
        
        // Calculate input level from Float32 samples
        var sum: Float = 0
        for i in 0..<frameLength {
            let sample = floatData[0][i]
            sum += sample * sample
        }
        let rms = sqrt(sum / Float(frameLength))
        let inputLevelValue = min(1.0, rms * 3) // Amplify for visual feedback
        if !firstNonZeroRmsLogged && rms > 0 {
            firstNonZeroRmsLogged = true
            print("📈 AudioService: first RMS > 0 detected (rms=\(rms), tapCount=\(tapTotalCount))")
        }
        
        // Extract waveform samples from Float32
        var waveformData: [Float] = []
        let sampleCount = 64
        let step = max(1, frameLength / sampleCount)
        for i in stride(from: 0, to: min(frameLength, sampleCount * step), by: step) {
            waveformData.append(abs(floatData[0][i]))
        }
        while waveformData.count < sampleCount {
            waveformData.append(0)
        }
        
        // Convert Float32 to PCM16 for API
        var audioData: Data?
        
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
                let convertedFrameLength = Int(convertedBuffer.frameLength)
                audioData = Data(bytes: channelData.pointee, count: convertedFrameLength * MemoryLayout<Int16>.size)
            }
        }
        
        // Send updates to main thread
        sendUIUpdates(level: inputLevelValue, waveform: waveformData, audio: audioData)
    }
    
    /// Send UI updates from audio thread to main thread
    private nonisolated func sendUIUpdates(level: Float, waveform: [Float], audio: Data?) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.inputLevel = level
            self.waveformSamples = waveform
            
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
        startTapDebugTimer()
        print("🎙️ AudioService: Recording started")
    }
    
    /// Stop recording
    @MainActor
    func stopRecording() {
        guard isRecording else { return }
        
        isRecording = false
        tapDebugTimer?.cancel()
        tapDebugTimer = nil
        
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
        
            // For playback-only, connect player directly to mainMixerNode
        guard let engine = audioEngine,
                  let player = playerNode else {
            throw AudioError.engineSetupFailed
            }
            
            let playbackFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: AudioConfig.sampleRate,
                channels: AudioConfig.channels,
                interleaved: false
            )!
            
            // FIX #1: Connect directly to mainMixerNode (no custom mixer)
            engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
            
            engine.prepare()
                    try engine.start()
            isEngineRunning = true
        }
        
        guard let player = playerNode, let engine = audioEngine else {
                throw AudioError.engineSetupFailed
        }
        
        // FIX #4: Comprehensive validation - check format AND engine connection state
        let format = player.outputFormat(forBus: 0)
        guard format.channelCount > 0,
              format.sampleRate > 0,
              engine.outputNode.engine != nil else {
            print("❌ AudioService: PlayerNode not properly connected - channelCount: \(format.channelCount), sampleRate: \(format.sampleRate), engineConnected: \(engine.outputNode.engine != nil)")
            throw AudioError.playbackFailed
        }
        
        isPlaying = true
        player.play()
        
        print("🔊 AudioService: Playback started")
    }
    
    /// Play PCM16 audio data (24kHz, mono)
    @MainActor
    func playAudio(_ audioData: Data) {
        guard isPlaying, let player = playerNode, let engine = audioEngine else { return }
        
        // FIX #4: Comprehensive validation before playing
        let format = player.outputFormat(forBus: 0)
        guard format.channelCount > 0,
              format.sampleRate > 0,
              engine.outputNode.engine != nil else {
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
        
        // Convert PCM16 to Float32 for playback
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
        tapDebugTimer?.cancel()
        tapDebugTimer = nil
        
        audioEngine = nil
        inputNode = nil
        playerNode = nil
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
    
    /// Whether voice processing is active on the input node
    func isVoiceProcessingActive() -> Bool {
        return inputNode?.isVoiceProcessingEnabled ?? false
    }
    
    // MARK: - Debug helpers
    
    private func startTapDebugTimer() {
        tapDebugTimer?.cancel()
        tapDebugTimer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
        tapDebugTicks = 0
        tapDebugTimer?.schedule(deadline: .now() + 0.5, repeating: 0.5)
        tapDebugTimer?.setEventHandler { [weak self] in
            guard let self else { return }
            self.tapDebugTicks += 1
            print("🟢 AudioService: tapTotalCount=\(self.tapTotalCount) firstRmsLogged=\(self.firstNonZeroRmsLogged)")
            if self.tapDebugTicks >= 4 {
                self.tapDebugTimer?.cancel()
                self.tapDebugTimer = nil
            }
        }
        tapDebugTimer?.resume()
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
