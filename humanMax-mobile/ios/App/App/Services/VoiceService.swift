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
    
    // Playback-aware suppression (keep mic open, gate what we send)
    private var isPlaybackSuppressionActive = false
    private var suppressionEndsAt: Date?
    private let suppressionTail: TimeInterval = 0.15 // shorter tail after TTS
    private let playbackSampleRate: Double = 24_000
    private let vadBreakThreshold: Float = 0.015 // lower threshold to allow barge-in sooner
    
    // Local ducking to reduce bleed during user speech
    private let duckThreshold: Float = 0.015
    private let duckedVolume: Float = 0.3  // gentler ducking
    private let duckRecoveryTail: TimeInterval = 0.35
    private var duckRestoreWorkItem: DispatchWorkItem?
    
    // Lightweight diagnostics
    private var framesSent = 0
    private var framesDropped = 0
    private var lastDebugLog = Date.distantPast
    private var suppressedFrameCounter = 0
    
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
                guard let self else { return }
                // Temporary: bypass suppression/ducking to verify capture path
                self.framesSent += 1
                try? await self.realtimeService.sendAudio(audioData)
                self.logAudioDebugIfNeeded(rms: self.rmsLevel(from: audioData))
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
                guard let self else { return }
                // Temporary: do not suppress mic during playback while verifying capture path
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
        
        // Handle speech state for echo cancellation
        // Attenuate playback volume when user is speaking to prevent echo feedback
        realtimeService.onSpeechStarted = { [weak self] in
            Task { @MainActor in
                // Temporary: disable ducking while verifying capture path
                self?.audioService.setOutputVolume(1.0)
            }
        }
        
        realtimeService.onSpeechStopped = { [weak self] in
            Task { @MainActor in
                // Restore full output volume when user stops speaking
                self?.audioService.setOutputVolume(1.0)
            }
        }
    }
    
    // MARK: - Voice Recording
    
    /// Current meeting ID for context
    private var currentMeetingId: String?
    
    /// Start voice recording and connect to realtime API
    /// - Parameter meetingId: Optional meeting ID for context injection
    func start(meetingId: String? = nil) async throws {
        guard !isRecording else {
            throw VoiceError.alreadyRecording
        }
        
        currentMeetingId = meetingId
        
        // Connect to realtime WebSocket with meeting context
        do {
            try await realtimeService.connect(meetingId: meetingId)
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
        
        // One-time zero buffer send to verify WS audio path
        if isConnected {
            let zeroData = Data(count: 320) // ~160 samples PCM16
            try? await realtimeService.sendAudio(zeroData)
            print("🧪 VoiceService: sent zero-buffer test frame")
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
    
    // MARK: - Playback-aware mic gating (keeps mic open)
    
    private func playbackDuration(for audioData: Data) -> TimeInterval {
        let frameCount = audioData.count / MemoryLayout<Int16>.size
        let duration = Double(frameCount) / playbackSampleRate
        return max(duration, 0.05) // cover tiny chunks
    }
    
    private func activatePlaybackSuppression(for duration: TimeInterval) {
        let end = Date().addingTimeInterval(duration + suppressionTail)
        suppressionEndsAt = end
        isPlaybackSuppressionActive = true
        suppressedFrameCounter = 0
        
        DispatchQueue.main.asyncAfter(deadline: .now() + duration + suppressionTail) { [weak self] in
            self?.refreshSuppressionState()
        }
    }
    
    private func refreshSuppressionState() {
        if let end = suppressionEndsAt, Date() >= end {
            suppressionEndsAt = nil
            isPlaybackSuppressionActive = false
            suppressedFrameCounter = 0
            print("🎚️ VoiceService: suppression cleared")
        }
    }
    
    private func shouldSendAudio(rms: Float?) -> Bool {
        // Outside suppression window, always send
        guard isPlaybackSuppressionActive,
              let end = suppressionEndsAt,
              Date() < end else {
            return true
        }
        
        guard let rms = rms else {
            // No RMS computed; allow periodic send-through to avoid full drop
            suppressedFrameCounter += 1
            return suppressedFrameCounter % 3 == 0
        }
        
        if rms >= vadBreakThreshold {
            // User is speaking loudly enough; drop suppression immediately
            suppressionEndsAt = nil
            isPlaybackSuppressionActive = false
            suppressedFrameCounter = 0
            return true
        }
        
        // Allow every 3rd frame during suppression to keep speech flowing
        suppressedFrameCounter += 1
        return suppressedFrameCounter % 3 == 0
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
    
    // MARK: - Local ducking during user speech
    
    private func maybeHandleDucking(rms: Float?) {
        guard let rms = rms else { return }
        
        if rms >= duckThreshold {
            audioService.setOutputVolume(duckedVolume)
            print("🔉 VoiceService: ducking output (rms=\(rms))")
            
            duckRestoreWorkItem?.cancel()
            let workItem = DispatchWorkItem { [weak self] in
                self?.audioService.setOutputVolume(1.0)
                print("🔉 VoiceService: ducking released")
            }
            duckRestoreWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + duckRecoveryTail, execute: workItem)
        }
    }
    
    // MARK: - Debug logging
    
    private func logAudioDebugIfNeeded(rms: Float?) {
        let now = Date()
        guard now.timeIntervalSince(lastDebugLog) > 1 else { return }
        
        let suppressionActive = isPlaybackSuppressionActive
        let rmsDisplay = rms.map { String(format: "%.4f", $0) } ?? "nil"
        let voiceProc = audioService.isVoiceProcessingActive()
        print("🔈 VoiceService: sent=\(framesSent) dropped=\(framesDropped) suppression=\(suppressionActive) rms=\(rmsDisplay) voiceProc=\(voiceProc)")
        lastDebugLog = now
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
