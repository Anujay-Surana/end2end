import Foundation
import Combine

/// High-level voice service integrating AudioService with RealtimeService
/// Provides a unified interface for voice conversations with live captions
@MainActor
class VoiceService: ObservableObject {
    static let shared = VoiceService()
    
    // MARK: - Published State
    
    @Published var isRecording = false
    @Published var isConnected = false
    @Published var connectionState: ConnectionState = .disconnected
    
    // Voice activity state
    @Published var isSpeaking = false
    @Published var isAssistantResponding = false
    
    // Live captions
    @Published var userTranscript: String = ""
    @Published var assistantTranscript: String = ""
    @Published var partialTranscript: String = ""
    
    // Audio levels for UI
    @Published var inputLevel: Float = 0
    @Published var outputLevel: Float = 0
    @Published var waveformSamples: [Float] = Array(repeating: 0, count: 64)
    
    // MARK: - Private Properties
    
    private let audioService: AudioService
    private let realtimeService: RealtimeService
    private var cancellables = Set<AnyCancellable>()
    
    // Callbacks
    var onTranscript: ((String, Bool, String) -> Void)? // (text, isFinal, source)
    var onResponse: ((String) -> Void)?
    var onError: ((Error) -> Void)?
    
    // MARK: - Initialization
    
    private init() {
        self.audioService = AudioService.shared
        self.realtimeService = RealtimeService.shared
        
        setupBindings()
        setupCallbacks()
    }
    
    // MARK: - Setup
    
    /// Setup Combine bindings for reactive state
    private func setupBindings() {
        // Bind audio levels
        audioService.$inputLevel
            .receive(on: DispatchQueue.main)
            .assign(to: &$inputLevel)
        
        audioService.$outputLevel
            .receive(on: DispatchQueue.main)
            .assign(to: &$outputLevel)
        
        audioService.$waveformSamples
            .receive(on: DispatchQueue.main)
            .assign(to: &$waveformSamples)
        
        // Bind realtime state
        realtimeService.$connectionState
            .receive(on: DispatchQueue.main)
            .assign(to: &$connectionState)
        
        realtimeService.$isConnected
            .receive(on: DispatchQueue.main)
            .assign(to: &$isConnected)
        
        realtimeService.$isSpeaking
            .receive(on: DispatchQueue.main)
            .assign(to: &$isSpeaking)
        
        realtimeService.$isResponding
            .receive(on: DispatchQueue.main)
            .assign(to: &$isAssistantResponding)
        
        // Bind transcripts
        realtimeService.$userTranscript
            .receive(on: DispatchQueue.main)
            .assign(to: &$userTranscript)
        
        realtimeService.$assistantTranscript
            .receive(on: DispatchQueue.main)
            .assign(to: &$assistantTranscript)
        
        realtimeService.$partialTranscript
            .receive(on: DispatchQueue.main)
            .assign(to: &$partialTranscript)
    }
    
    /// Setup callbacks between services
    private func setupCallbacks() {
        // Handle audio data from microphone -> send to realtime service
        audioService.onAudioData = { [weak self] audioData in
            Task { @MainActor in
                try? await self?.realtimeService.sendAudio(audioData)
            }
        }
        
        // Handle transcript updates
        realtimeService.onTranscript = { [weak self] text, isFinal, source in
            Task { @MainActor in
                self?.onTranscript?(text, isFinal, source)
            }
        }
        
        // Handle text responses
        realtimeService.onResponse = { [weak self] text in
            Task { @MainActor in
                self?.onResponse?(text)
            }
        }
        
        // Handle audio playback from AI
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
        
        // Handle connection state changes
        realtimeService.onConnectionStateChanged = { [weak self] state in
            Task { @MainActor in
                self?.connectionState = state
                if case .connected = state {
                    self?.isConnected = true
                } else if case .disconnected = state {
                    self?.isConnected = false
                } else if case .failed = state {
                    self?.isConnected = false
                }
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
            realtimeService.disconnect()
            throw VoiceError.recordingFailed(error.localizedDescription)
        }
        
        // Start audio playback for responses
        do {
            try audioService.startPlayback()
        } catch {
            print("⚠️ VoiceService: Failed to setup audio playback: \(error)")
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
        
        // Clear transcripts
        userTranscript = ""
        assistantTranscript = ""
        partialTranscript = ""
    }
    
    // MARK: - Text Input
    
    /// Send text message to realtime API
    func sendText(_ text: String) async throws {
        guard isConnected else {
            throw VoiceError.notConnected
        }
        
        try await realtimeService.sendText(text)
    }
    
    /// Send stop signal to cancel AI response
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
            await stop()
        }
        
        realtimeService.resetReconnection()
        try await start()
    }
    
    /// Get current connection state description
    func connectionStateDescription() -> String {
        switch connectionState {
        case .disconnected:
            return "Disconnected"
        case .connecting:
            return "Connecting..."
        case .connected:
            return "Connected"
        case .reconnecting(let attempt):
            return "Reconnecting (\(attempt)/5)..."
        case .failed(let reason):
            return "Failed: \(reason)"
        }
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
