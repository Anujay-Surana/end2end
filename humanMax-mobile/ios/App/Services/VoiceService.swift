import Foundation

/// High-level voice service integrating AudioService with RealtimeService
@MainActor
class VoiceService: ObservableObject {
    static let shared = VoiceService()
    
    @Published var isRecording = false
    @Published var isConnected = false
    
    private let audioService: AudioService
    private let realtimeService: RealtimeService
    
    // Playback-aware gating (keep mic open, but suppress sends during TTS)
    private var isPlaybackSuppressionActive = false
    private var suppressionEndsAt: Date?
    private let suppressionTail: TimeInterval = 0.25 // leave a short tail after playback
    private let playbackSampleRate: Double = 16_000
    private let vadBreakThreshold: Float = 0.035 // normalized RMS; allow barge-in when exceeded
    
    // Callbacks
    var onTranscript: ((String, Bool) -> Void)? // (text, isFinal)
    var onResponse: ((String) -> Void)? // Text response
    var onError: ((Error) -> Void)? // Error callback
    
    private init() {
        self.audioService = AudioService.shared
        self.realtimeService = RealtimeService.shared
        
        setupCallbacks()
    }
    
    // MARK: - Setup
    
    /// Setup callbacks for realtime service
    private func setupCallbacks() {
        // Handle audio data from microphone
        audioService.onAudioData = { [weak self] audioData in
            Task { @MainActor in
                guard let self else { return }
                
                // Check suppression window; allow barge-in if user voice is strong enough
                self.refreshSuppressionState()
                let rms = self.rmsLevel(from: audioData)
                
                if self.shouldSendAudio(rms: rms) {
                    try? await self.realtimeService.sendAudio(audioData)
                }
            }
        }
        
        // Handle transcript updates
        realtimeService.onTranscript = { [weak self] text, isFinal in
            Task { @MainActor in
                self?.onTranscript?(text, isFinal)
            }
        }
        
        // Handle text responses
        realtimeService.onResponse = { [weak self] text in
            Task { @MainActor in
                self?.onResponse?(text)
            }
        }
        
        // Handle audio playback from OpenAI
        realtimeService.onAudio = { [weak self] audioData in
            Task { @MainActor in
                guard let self else { return }
                
                // Activate suppression while TTS audio plays (mic stays open)
                self.activatePlaybackSuppression(for: self.playbackDuration(for: audioData))
                self.audioService.playAudio(audioData)
            }
        }
        
        // Handle errors
        realtimeService.onError = { [weak self] error in
            Task { @MainActor in
                self?.onError?(error)
            }
        }
        
        // Handle connection ready
        realtimeService.onReady = { [weak self] in
            Task { @MainActor in
                self?.isConnected = true
            }
        }
    }
    
    // MARK: - Voice Recording
    
    /// Start voice recording and connect to realtime API
    func start() async throws {
        guard !isRecording else {
            throw VoiceError.alreadyRecording
        }
        
        // Connect to realtime WebSocket
        do {
            try await realtimeService.connect()
        } catch {
            throw VoiceError.connectionFailed(error.localizedDescription)
        }
        
        // Start audio capture
        do {
            try await audioService.startRecording()
            isRecording = true
        } catch {
            // Disconnect WebSocket if audio fails
            realtimeService.disconnect()
            throw VoiceError.recordingFailed(error.localizedDescription)
        }
        
        // Start audio playback for responses
        do {
            try audioService.startPlayback()
        } catch {
            // Continue even if playback setup fails
            print("Warning: Failed to setup audio playback: \(error)")
        }
    }
    
    /// Stop voice recording
    func stop() async {
        guard isRecording else { return }
        
        // Stop audio capture
        audioService.stopRecording()
        isRecording = false
        
        // Stop audio playback
        audioService.stopPlayback()
        
        // Disconnect WebSocket
        realtimeService.disconnect()
        isConnected = false
    }
    
    // MARK: - Text Input
    
    /// Send text message to realtime API
    func sendText(_ text: String) async throws {
        guard isConnected else {
            throw VoiceError.notConnected
        }
        
        try await realtimeService.sendText(text)
    }
    
    /// Send stop signal to realtime API
    func sendStop() async throws {
        guard isConnected else {
            throw VoiceError.notConnected
        }
        
        try await realtimeService.sendStop()
    }
    
    // MARK: - Connection Management
    
    /// Check if connected to realtime API
    func checkConnection() -> Bool {
        return realtimeService.isConnectedToServer() && isConnected
    }
    
    /// Reconnect to realtime API
    func reconnect() async throws {
        if isRecording {
            try await stop()
        }
        
        try await start()
    }
    
    // MARK: - Playback-aware mic gating (keeps mic open)
    
    private func playbackDuration(for audioData: Data) -> TimeInterval {
        let frameCount = audioData.count / MemoryLayout<Int16>.size
        let duration = Double(frameCount) / playbackSampleRate
        // Minimal duration to cover tiny chunks, plus small tail added elsewhere
        return max(duration, 0.05)
    }
    
    private func activatePlaybackSuppression(for duration: TimeInterval) {
        let end = Date().addingTimeInterval(duration + suppressionTail)
        suppressionEndsAt = end
        isPlaybackSuppressionActive = true
        
        // Auto-clear after the window unless already cleared due to barge-in
        let delay = duration + suppressionTail
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.refreshSuppressionState()
        }
    }
    
    private func refreshSuppressionState() {
        if let end = suppressionEndsAt, Date() >= end {
            suppressionEndsAt = nil
            isPlaybackSuppressionActive = false
        }
    }
    
    private func shouldSendAudio(rms: Float?) -> Bool {
        // Outside suppression window, always send
        guard isPlaybackSuppressionActive, let end = suppressionEndsAt, Date() < end else {
            return true
        }
        
        guard let rms = rms else {
            // No RMS computed; stay conservative and suppress
            return false
        }
        
        if rms >= vadBreakThreshold {
            // User is speaking loud enough — drop suppression immediately
            suppressionEndsAt = nil
            isPlaybackSuppressionActive = false
            return true
        }
        
        return false
    }
    
    private func rmsLevel(from audioData: Data) -> Float? {
        let sampleCount = audioData.count / MemoryLayout<Int16>.size
        guard sampleCount > 0 else { return nil }
        
        var sum: Float = 0
        audioData.withUnsafeBytes { rawBuffer in
            let buffer = rawBuffer.bindMemory(to: Int16.self)
            for i in 0..<sampleCount {
                let normalized = Float(buffer[i]) / Float(Int16.max)
                sum += normalized * normalized
            }
        }
        
        let mean = sum / Float(sampleCount)
        return sqrt(mean)
    }
}

// MARK: - Voice Error Types

enum VoiceError: Error, LocalizedError {
    case alreadyRecording
    case notRecording
    case notConnected
    case connectionFailed(String)
    case recordingFailed(String)
    case permissionDenied
    
    var errorDescription: String? {
        switch self {
        case .alreadyRecording:
            return "Voice recording already in progress"
        case .notRecording:
            return "Voice recording is not active"
        case .notConnected:
            return "Not connected to realtime API"
        case .connectionFailed(let msg):
            return "Connection failed: \(msg)"
        case .recordingFailed(let msg):
            return "Recording failed: \(msg)"
        case .permissionDenied:
            return "Microphone permission denied"
        }
    }
}

