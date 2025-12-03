import Foundation
import AVFoundation

/// Service for low-level audio capture and playback using AVAudioEngine
class AudioService {
    static let shared = AudioService()
    
    private var audioEngine: AVAudioEngine?
    private var inputNode: AVAudioInputNode?
    private var playerNode: AVAudioPlayerNode?
    private var audioFormat: AVAudioFormat?
    private var isRecording = false
    private var isPlaying = false
    
    // Audio capture callback
    var onAudioData: ((Data) -> Void)? // PCM16 audio data
    
    // Audio playback buffer
    private var audioBuffer: [Data] = []
    private var playbackQueue: DispatchQueue?
    
    private init() {}
    
    // MARK: - Audio Session Setup
    
    /// Setup audio engine with optimal configuration for low latency
    private func setupAudioEngine() throws {
        // If engine is already running, don't setup again
        if let engine = audioEngine, engine.isRunning {
            return
        }
        
        // If engine exists but is stopped, restart it
        if let engine = audioEngine, let playerNode = playerNode, let format = audioFormat {
            if !engine.isRunning {
                try engine.start()
            }
            return
        }
        
        // Create new engine and nodes
        audioEngine = AVAudioEngine()
        guard let engine = audioEngine else {
            throw AudioError.engineSetupFailed
        }
        
        inputNode = engine.inputNode
        playerNode = AVAudioPlayerNode()
        
        guard let playerNode = playerNode else {
            throw AudioError.engineSetupFailed
        }
        
        // Configure for 16kHz, 16-bit PCM (OpenAI Realtime API requirement)
        audioFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16000,
            channels: 1,
            interleaved: false
        )
        
        guard let format = audioFormat else {
            throw AudioError.invalidFormat
        }
        
        // Optimize audio session for low latency
        let audioSession = AVAudioSession.sharedInstance()
        
        // Use voiceChat mode for lowest latency
        try audioSession.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetooth]
        )
        
        // Set preferred buffer duration to 5ms for ultra-low latency (default is ~23ms)
        try audioSession.setPreferredIOBufferDuration(0.005)
        
        // Set preferred sample rate
        try audioSession.setPreferredSampleRate(16000)
        
        try audioSession.setActive(true)
        
        // Attach and connect player node for audio playback
        engine.attach(playerNode)
        engine.connect(playerNode, to: engine.mainMixerNode, format: format)
        
        // Start audio engine
        try engine.start()
    }
    
    // MARK: - Audio Capture
    
    /// Request microphone permission and start recording
    func startRecording() async throws {
        guard !isRecording else {
            throw AudioError.alreadyRecording
        }
        
        // Request microphone permission
        let granted = await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
        guard granted else {
            throw AudioError.permissionDenied
        }
        
        // Setup audio engine if not already set up
        if audioEngine == nil {
            try setupAudioEngine()
        }
        
        guard let engine = audioEngine,
              let input = inputNode,
              let format = audioFormat else {
            throw AudioError.engineSetupFailed
        }
        
        isRecording = true
        
        // Install tap to capture audio with optimized buffer size for low latency
        // Buffer size 1024 frames = 64ms at 16kHz (good balance of latency vs processing overhead)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, time in
            guard let self = self, self.isRecording else { return }
            
            // Convert buffer to PCM16 Data
            guard let channelData = buffer.int16ChannelData else { return }
            let channelDataValue = channelData.pointee
            let frameLength = Int(buffer.frameLength)
            
            // Create Data from PCM16 buffer
            let audioData = Data(bytes: channelDataValue, count: frameLength * MemoryLayout<Int16>.size)
            
            // Call callback with audio data
            self.onAudioData?(audioData)
        }
    }
    
    /// Stop recording
    func stopRecording() {
        guard isRecording else { return }
        
        isRecording = false
        inputNode?.removeTap(onBus: 0)
    }
    
    // MARK: - Audio Playback
    
    /// Start audio playback
    func startPlayback() throws {
        guard !isPlaying else {
            throw AudioError.alreadyPlaying
        }
        
        guard let engine = audioEngine,
              let playerNode = playerNode,
              let format = audioFormat else {
            throw AudioError.engineSetupFailed
        }
        
        // Setup audio engine if not already set up
        if audioEngine == nil {
            try setupAudioEngine()
        }
        
        isPlaying = true
        
        // Create playback queue
        playbackQueue = DispatchQueue(label: "com.kordn8.shadow.audio.playback", qos: .userInitiated)
        
        // Start player node
        playerNode.play()
    }
    
    /// Play PCM16 audio data
    func playAudio(_ audioData: Data) {
        guard isPlaying, let playerNode = playerNode, let format = audioFormat else {
            return
        }
        
        // Convert Data to AVAudioPCMBuffer
        guard let buffer = createPCMBuffer(from: audioData, format: format) else {
            return
        }
        
        // Schedule buffer for playback
        playerNode.scheduleBuffer(buffer, completionHandler: nil)
    }
    
    /// Stop audio playback
    func stopPlayback() {
        guard isPlaying else { return }
        
        isPlaying = false
        playerNode?.stop()
        audioBuffer.removeAll()
    }
    
    /// Create AVAudioPCMBuffer from PCM16 Data
    private func createPCMBuffer(from data: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let frameCapacity = data.count / MemoryLayout<Int16>.size
        
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frameCapacity)) else {
            return nil
        }
        
        buffer.frameLength = AVAudioFrameCount(frameCapacity)
        
        // Copy PCM16 data to buffer
        guard let channelData = buffer.int16ChannelData else {
            return nil
        }
        
        let channelDataValue = channelData.pointee
        data.withUnsafeBytes { bytes in
            let int16Pointer = bytes.bindMemory(to: Int16.self)
            channelDataValue.initialize(from: int16Pointer.baseAddress!, count: frameCapacity)
        }
        
        return buffer
    }
    
    // MARK: - Cleanup
    
    /// Stop all audio operations and cleanup
    func stopAll() {
        stopRecording()
        stopPlayback()
        
        audioEngine?.stop()
        audioEngine = nil
        inputNode = nil
        playerNode = nil
        audioFormat = nil
        
        // Deactivate audio session
        try? AVAudioSession.sharedInstance().setActive(false)
    }
    
    // MARK: - Status
    
    /// Check if currently recording
    func isCurrentlyRecording() -> Bool {
        return isRecording
    }
    
    /// Check if currently playing
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
            return "Already playing audio"
        case .playbackFailed:
            return "Audio playback failed"
        }
    }
}

