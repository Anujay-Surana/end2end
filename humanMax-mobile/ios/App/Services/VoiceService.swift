import Foundation

/// High-level voice service integrating AudioService with RealtimeService
@MainActor
class VoiceService: ObservableObject {
    static let shared = VoiceService()
    
    @Published var isRecording = false
    @Published var isConnected = false
    
    private let audioService: AudioService
    private let realtimeService: RealtimeService
    
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
                try? await self?.realtimeService.sendAudio(audioData)
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
                self?.audioService.playAudio(audioData)
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

