import Foundation

/// Service for managing WebSocket connection to backend realtime API
class RealtimeService {
    static let shared = RealtimeService()
    
    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession
    private let keychainService: KeychainService
    private var isConnected = false
    private var receiveTask: Task<Void, Never>?
    
    // Callbacks
    var onTranscript: ((String, Bool) -> Void)? // (text, isFinal)
    var onAudio: ((Data) -> Void)? // Audio data (PCM16)
    var onResponse: ((String) -> Void)? // Text response
    var onError: ((Error) -> Void)? // Error callback
    var onReady: (() -> Void)? // Connection ready
    
    private init() {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30.0
        self.urlSession = URLSession(configuration: configuration)
        self.keychainService = KeychainService.shared
    }
    
    // MARK: - Connection Management
    
    /// Connect to realtime WebSocket endpoint
    func connect() async throws {
        guard !isConnected else {
            return
        }
        
        // Build WebSocket URL with authentication token
        var components = URLComponents(string: Constants.realtimeWebSocketURL)
        if let sessionToken = keychainService.getSessionToken() {
            components?.queryItems = [URLQueryItem(name: "token", value: sessionToken)]
        }
        
        guard let url = components?.url else {
            throw RealtimeError.invalidURL
        }
        
        // Create WebSocket task
        webSocketTask = urlSession.webSocketTask(with: url)
        webSocketTask?.resume()
        
        isConnected = true
        
        // Start receiving messages
        startReceiving()
        
        // Wait for ready message
        try await waitForReady()
    }
    
    /// Disconnect from WebSocket
    func disconnect() {
        receiveTask?.cancel()
        receiveTask = nil
        
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        
        isConnected = false
    }
    
    /// Wait for ready message from server
    private func waitForReady() async throws {
        // Give server a moment to send ready message
        try await Task.sleep(nanoseconds: 1_000_000_000) // 1 second
        
        // Check if we received ready message (handled in receive loop)
        onReady?()
    }
    
    // MARK: - Message Sending
    
    /// Send text message to OpenAI Realtime API
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
    
    /// Send audio data to OpenAI Realtime API
    func sendAudio(_ audioData: Data) async throws {
        guard let webSocketTask = webSocketTask, isConnected else {
            throw RealtimeError.notConnected
        }
        
        // Encode audio as base64
        let base64Audio = audioData.base64EncodedString()
        
        let messageDict: [String: Any] = [
            "type": "audio",
            "audio": base64Audio
        ]
        
        guard let jsonData = try? JSONSerialization.data(withJSONObject: messageDict),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            throw RealtimeError.encodingError
        }
        
        let message = URLSessionWebSocketTask.Message.string(jsonString)
        try await webSocketTask.send(message)
    }
    
    /// Send stop signal
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
                    await handleDataMessage(data)
                @unknown default:
                    break
                }
            } catch {
                if !Task.isCancelled {
                    isConnected = false
                    onError?(error)
                }
                break
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
                onTranscript?(transcriptText, isFinal)
            }
            
        case "realtime_audio":
            if let audioBase64 = json["audio"] as? String,
               let audioData = Data(base64Encoded: audioBase64) {
                onAudio?(audioData)
            }
            
        case "realtime_response":
            if let responseText = json["text"] as? String {
                onResponse?(responseText)
            }
            
        case "error":
            if let errorMessage = json["message"] as? String {
                onError?(RealtimeError.serverError(errorMessage))
            }
            
        default:
            // Handle other message types
            break
        }
    }
    
    /// Handle binary data message
    private func handleDataMessage(_ data: Data) async {
        // Handle binary audio data if needed
        onAudio?(data)
    }
    
    // MARK: - Connection Status
    
    /// Check if connected
    func isConnectedToServer() -> Bool {
        return isConnected && webSocketTask != nil
    }
    
    /// Send ping to keep connection alive
    func ping() async throws {
        guard let webSocketTask = webSocketTask, isConnected else {
            return
        }
        
        try await webSocketTask.sendPing { error in
            if let error = error {
                self.onError?(error)
            }
        }
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
            return "Failed to connect to WebSocket"
        }
    }
}

