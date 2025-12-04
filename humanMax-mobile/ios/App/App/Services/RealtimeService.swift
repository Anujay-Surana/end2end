import Foundation
import Combine

/// Connection state for the realtime service
enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case reconnecting(attempt: Int)
    case failed(reason: String)
}

/// Service for managing WebSocket connection to backend realtime API
/// Supports binary audio streaming and automatic reconnection
@MainActor
class RealtimeService: ObservableObject {
    static let shared = RealtimeService()
    
    // MARK: - Published Properties
    
    @Published private(set) var connectionState: ConnectionState = .disconnected
    @Published private(set) var isConnected = false
    @Published private(set) var isSpeaking = false // User is speaking (VAD)
    @Published private(set) var isResponding = false // AI is responding
    
    // Live caption state
    @Published var userTranscript: String = ""
    @Published var assistantTranscript: String = ""
    @Published var partialTranscript: String = ""
    
    // MARK: - Private Properties
    
    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession
    private let keychainService: KeychainService
    private var receiveTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    
    // Reconnection
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 5
    private var shouldReconnect = true
    
    // MARK: - Callbacks
    
    var onTranscript: ((String, Bool, String) -> Void)? // (text, isFinal, source: "user"/"assistant")
    var onAudio: ((Data) -> Void)? // Raw PCM16 audio data
    var onResponse: ((String) -> Void)? // Text response
    var onError: ((Error) -> Void)?
    var onReady: (() -> Void)?
    var onSpeechStarted: (() -> Void)?
    var onSpeechStopped: (() -> Void)?
    var onResponseDone: (() -> Void)?
    var onConnectionStateChanged: ((ConnectionState) -> Void)?
    
    // MARK: - Initialization
    
    private init() {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30.0
        configuration.waitsForConnectivity = true
        self.urlSession = URLSession(configuration: configuration)
        self.keychainService = KeychainService.shared
    }
    
    // MARK: - Connection State
    
    /// Current meeting ID (for context injection)
    private var currentMeetingId: String?
    
    // MARK: - Connection Management
    
    /// Connect to realtime WebSocket endpoint
    /// - Parameter meetingId: Optional meeting ID for context injection
    func connect(meetingId: String? = nil) async throws {
        guard connectionState != .connected && connectionState != .connecting else {
            return
        }
        
        currentMeetingId = meetingId
        shouldReconnect = true
        reconnectAttempts = 0
        connectionState = .connecting
        onConnectionStateChanged?(.connecting)
        
        try await performConnect()
    }
    
    /// Internal connection logic
    private func performConnect() async throws {
        // Build WebSocket URL with authentication token and optional meeting_id
        var components = URLComponents(string: Constants.realtimeWebSocketURL)
        var queryItems: [URLQueryItem] = []
        
        if let sessionToken = keychainService.getSessionToken() {
            queryItems.append(URLQueryItem(name: "token", value: sessionToken))
        }
        
        if let meetingId = currentMeetingId {
            queryItems.append(URLQueryItem(name: "meeting_id", value: meetingId))
        }
        
        if !queryItems.isEmpty {
            components?.queryItems = queryItems
        }
        
        guard let url = components?.url else {
            connectionState = .failed(reason: "Invalid URL")
            throw RealtimeError.invalidURL
        }
        
        // Create WebSocket task
        webSocketTask = urlSession.webSocketTask(with: url)
        webSocketTask?.resume()
        
        isConnected = true
        connectionState = .connected
        reconnectAttempts = 0
        onConnectionStateChanged?(.connected)
        
        // Start receiving messages
        startReceiving()
        
        // Start heartbeat
        startHeartbeat()
        
        // Wait for ready message
        try await waitForReady()
    }
    
    /// Disconnect from WebSocket
    func disconnect() {
        shouldReconnect = false
        
        heartbeatTask?.cancel()
        heartbeatTask = nil
        
        receiveTask?.cancel()
        receiveTask = nil
        
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        
        isConnected = false
        isSpeaking = false
        isResponding = false
        connectionState = .disconnected
        onConnectionStateChanged?(.disconnected)
        
        // Clear transcripts
        userTranscript = ""
        assistantTranscript = ""
        partialTranscript = ""
    }
    
    /// Attempt to reconnect with exponential backoff
    private func attemptReconnect() async {
        guard shouldReconnect && reconnectAttempts < maxReconnectAttempts else {
            connectionState = .failed(reason: "Max reconnection attempts reached")
            onConnectionStateChanged?(connectionState)
            return
        }
        
        reconnectAttempts += 1
        connectionState = .reconnecting(attempt: reconnectAttempts)
        onConnectionStateChanged?(connectionState)
        
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        let delay = pow(2.0, Double(reconnectAttempts - 1))
        print("🔄 RealtimeService: Reconnecting in \(delay)s (attempt \(reconnectAttempts)/\(maxReconnectAttempts))")
        
        do {
            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            
            guard shouldReconnect else { return }
            
            try await performConnect()
            print("✅ RealtimeService: Reconnected successfully")
        } catch {
            print("❌ RealtimeService: Reconnect failed: \(error.localizedDescription)")
            await attemptReconnect()
        }
    }
    
    /// Wait for ready message from server
    private func waitForReady() async throws {
        // Give server a moment to send ready message
        try await Task.sleep(nanoseconds: 500_000_000) // 0.5 seconds
        onReady?()
    }
    
    // MARK: - Heartbeat
    
    /// Start heartbeat to keep connection alive
    private func startHeartbeat() {
        heartbeatTask = Task {
            while !Task.isCancelled && isConnected {
                do {
                    try await Task.sleep(nanoseconds: 15_000_000_000) // 15 seconds
                    await ping()
                } catch {
                    break
                }
            }
        }
    }
    
    /// Send ping to keep connection alive
    func ping() async {
        guard let webSocketTask = webSocketTask, isConnected else {
            return
        }
        
        webSocketTask.sendPing { [weak self] error in
            if let error = error {
                print("⚠️ RealtimeService: Ping failed: \(error.localizedDescription)")
                Task { @MainActor in
                    self?.handleDisconnect()
                }
            }
        }
    }
    
    // MARK: - Message Sending
    
    /// Send text message to backend
    func sendText(_ text: String) async throws {
        guard let webSocketTask = webSocketTask, isConnected else {
            throw RealtimeError.notConnected
        }
        
        let messageDict: [String: Any] = [
            "type": "text",
            "text": text
        ]
        
        guard let jsonData = try? JSONSerialization.data(withJSONObject: messageDict),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            throw RealtimeError.encodingError
        }
        
        let message = URLSessionWebSocketTask.Message.string(jsonString)
        try await webSocketTask.send(message)
    }
    
    /// Send raw audio data as binary WebSocket message (low latency)
    func sendAudio(_ audioData: Data) async throws {
        guard let webSocketTask = webSocketTask, isConnected else {
            throw RealtimeError.notConnected
        }
        
        // Send as raw binary - no JSON/base64 encoding for minimum latency
        let message = URLSessionWebSocketTask.Message.data(audioData)
        try await webSocketTask.send(message)
    }
    
    /// Send stop signal to cancel AI response
    func sendStop() async throws {
        guard let webSocketTask = webSocketTask, isConnected else {
            throw RealtimeError.notConnected
        }
        
        let messageDict: [String: Any] = [
            "type": "stop"
        ]
        
        guard let jsonData = try? JSONSerialization.data(withJSONObject: messageDict),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            throw RealtimeError.encodingError
        }
        
        let message = URLSessionWebSocketTask.Message.string(jsonString)
        try await webSocketTask.send(message)
    }
    
    /// Send ping message (JSON)
    func sendPing() async throws {
        guard let webSocketTask = webSocketTask, isConnected else {
            throw RealtimeError.notConnected
        }
        
        let messageDict: [String: Any] = ["type": "ping"]
        
        guard let jsonData = try? JSONSerialization.data(withJSONObject: messageDict),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            throw RealtimeError.encodingError
        }
        
        let message = URLSessionWebSocketTask.Message.string(jsonString)
        try await webSocketTask.send(message)
    }
    
    // MARK: - Message Receiving
    
    /// Start receiving messages from WebSocket
    private func startReceiving() {
        receiveTask = Task {
            await receiveMessages()
        }
    }
    
    /// Receive and process messages
    private func receiveMessages() async {
        guard let webSocketTask = webSocketTask else { return }
        
        while isConnected && !Task.isCancelled {
            do {
                let message = try await webSocketTask.receive()
                
                switch message {
                case .string(let text):
                    await handleTextMessage(text)
                case .data(let data):
                    // Binary audio data - pass directly to callback (no decoding needed)
                    onAudio?(data)
                @unknown default:
                    break
                }
            } catch {
                if !Task.isCancelled {
                    handleDisconnect()
                }
                break
            }
        }
    }
    
    /// Handle disconnection and attempt reconnect
    private func handleDisconnect() {
        guard isConnected else { return }
        
        isConnected = false
        isSpeaking = false
        isResponding = false
        
        webSocketTask?.cancel(with: .abnormalClosure, reason: nil)
        webSocketTask = nil
        
        heartbeatTask?.cancel()
        heartbeatTask = nil
        
        receiveTask?.cancel()
        receiveTask = nil
        
        onError?(RealtimeError.connectionFailed)
        
        // Attempt reconnect if allowed
        if shouldReconnect {
            Task {
                await attemptReconnect()
            }
        }
    }
    
    /// Handle text message from WebSocket
    private func handleTextMessage(_ text: String) async {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return
        }
        
        switch type {
        case "realtime_ready":
            onReady?()
            
        case "realtime_transcript":
            if let transcriptText = json["text"] as? String,
               let isFinal = json["is_final"] as? Bool {
                let source = json["source"] as? String ?? "user"
                
                // Log transcript for debugging
                print("📝 Transcript [\(source)] final=\(isFinal): \(transcriptText.prefix(50))...")
                
                // Update published transcripts for live captions
                if source == "user" {
                    if isFinal {
                        userTranscript = transcriptText
                        partialTranscript = ""
                    } else {
                        partialTranscript = transcriptText
                    }
                } else if source == "assistant" {
                    // Set responding flag when we start receiving assistant transcripts
                    if !isResponding {
                        isResponding = true
                        print("🤖 Assistant started responding (from transcript)")
                    }
                    
                    if isFinal {
                        assistantTranscript = transcriptText
                        partialTranscript = ""
                    } else {
                        // For partial transcripts, accumulate the delta text
                        partialTranscript += transcriptText
                    }
                }
                
                onTranscript?(transcriptText, isFinal, source)
            }
            
        case "realtime_response":
            if let responseText = json["text"] as? String {
                onResponse?(responseText)
            }
            
        case "realtime_speech_started":
            isSpeaking = true
            isResponding = false
            partialTranscript = ""
            onSpeechStarted?()
            
        case "realtime_speech_stopped":
            isSpeaking = false
            onSpeechStopped?()
            
        case "realtime_response_done":
            isResponding = false
            onResponseDone?()
            
        case "realtime_error", "error":
            if let errorDict = json["error"] as? [String: Any],
               let errorMessage = errorDict["message"] as? String {
                onError?(RealtimeError.serverError(errorMessage))
            } else if let errorMessage = json["message"] as? String {
                onError?(RealtimeError.serverError(errorMessage))
            }
            
        case "pong":
            // Heartbeat response received
            break
            
        case "realtime_event":
            // Handle session events if needed
            if let event = json["event"] as? [String: Any],
               let eventType = event["type"] as? String {
                if eventType == "response.audio.delta" {
                    isResponding = true
                }
            }
        
        // Handle text deltas (alternative to audio transcript)
        case "realtime_text_delta":
            if let delta = json["delta"] as? String, !delta.isEmpty {
                if !isResponding {
                    isResponding = true
                    print("🤖 Assistant started responding (from text delta)")
                }
                partialTranscript += delta
                print("📝 Text delta: \(delta)")
            }
        
        case "realtime_text_done":
            if let text = json["text"] as? String, !text.isEmpty {
                assistantTranscript = text
                partialTranscript = ""
                print("📝 Text done: \(text.prefix(50))...")
                onTranscript?(text, true, "assistant")
            }
        
        // Handle content parts which may contain text
        case "realtime_content_part_added":
            if let part = json["part"] as? [String: Any],
               let partType = part["type"] as? String {
                if partType == "text", let text = part["text"] as? String {
                    print("📝 Content part text: \(text.prefix(50))...")
                }
            }
        
        case "realtime_content_part_done":
            if let part = json["part"] as? [String: Any],
               let partType = part["type"] as? String {
                if partType == "text", let text = part["text"] as? String, !text.isEmpty {
                    assistantTranscript = text
                    print("📝 Content part done (text): \(text.prefix(50))...")
                    onTranscript?(text, true, "assistant")
                } else if partType == "audio", let transcript = part["transcript"] as? String, !transcript.isEmpty {
                    assistantTranscript = transcript
                    print("📝 Content part done (audio transcript): \(transcript.prefix(50))...")
                    onTranscript?(transcript, true, "assistant")
                }
            }
        
        // Handle output items which may contain transcripts
        case "realtime_output_item_done":
            if let item = json["item"] as? [String: Any] {
                // Check for transcript in the item
                if let content = item["content"] as? [[String: Any]] {
                    for part in content {
                        if let partType = part["type"] as? String {
                            if partType == "audio", let transcript = part["transcript"] as? String, !transcript.isEmpty {
                                assistantTranscript = transcript
                                print("📝 Output item transcript: \(transcript.prefix(50))...")
                                onTranscript?(transcript, true, "assistant")
                            } else if partType == "text", let text = part["text"] as? String, !text.isEmpty {
                                assistantTranscript = text
                                print("📝 Output item text: \(text.prefix(50))...")
                                onTranscript?(text, true, "assistant")
                            }
                        }
                    }
                }
            }
            isResponding = false
        
        // Handle response completion
        case "realtime_response_created":
            isResponding = true
            print("🎬 Response started")
        
        case "realtime_audio_done":
            // Audio finished, but transcript might still come
            print("🔊 Audio done")
        
        // Informational messages (reduce log noise)
        case "realtime_session", "realtime_input_committed", "realtime_input_cleared",
             "realtime_item_created", "realtime_output_item_added", "realtime_rate_limits":
            // These are informational, no action needed
            break
            
        default:
            // Log unknown message types for debugging
            print("📨 RealtimeService: Unknown message type: \(type) - keys: \(json.keys.sorted())")
        }
    }
    
    // MARK: - Connection Status
    
    /// Check if connected
    func isConnectedToServer() -> Bool {
        return isConnected && webSocketTask != nil
    }
    
    /// Reset reconnection state
    func resetReconnection() {
        reconnectAttempts = 0
        shouldReconnect = true
    }
}

// MARK: - Realtime Error Types

enum RealtimeError: Error, LocalizedError {
    case invalidURL
    case notConnected
    case encodingError
    case decodingError
    case serverError(String)
    case connectionFailed
    case maxReconnectAttemptsReached
    
    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid WebSocket URL"
        case .notConnected:
            return "Not connected to WebSocket"
        case .encodingError:
            return "Failed to encode message"
        case .decodingError:
            return "Failed to decode message"
        case .serverError(let msg):
            return "Server error: \(msg)"
        case .connectionFailed:
            return "Connection failed"
        case .maxReconnectAttemptsReached:
            return "Maximum reconnection attempts reached"
        }
    }
}
