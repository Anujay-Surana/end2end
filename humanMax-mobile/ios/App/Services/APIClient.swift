import Foundation

/// API Client for making HTTP requests to the backend
class APIClient {
    static let shared = APIClient()
    
    private let baseURL: String
    private let session: URLSession
    private let keychainService: KeychainService
    private let retryDelay: TimeInterval = 1.0
    private let maxRetries = 3
    
    private init() {
        self.baseURL = Constants.apiBaseURL
        self.keychainService = KeychainService.shared
        
        // Configure URLSession with timeout
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30.0
        configuration.timeoutIntervalForResource = 300.0 // 5 minutes for long operations
        self.session = URLSession(configuration: configuration)
    }
    
    // MARK: - Request Building
    
    /// Build a URL request with authentication headers
    private func buildRequest(
        endpoint: String,
        method: String = "GET",
        body: Data? = nil,
        headers: [String: String] = [:]
    ) -> URLRequest? {
        guard let url = URL(string: "\(baseURL)\(endpoint)") else {
            return nil
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        // Add platform header for mobile identification
        request.setValue("ios", forHTTPHeaderField: "X-Platform")
        
        // Add authentication header if session token exists
        if let sessionToken = keychainService.getSessionToken() {
            request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        }
        
        // Add custom headers
        for (key, value) in headers {
            request.setValue(value, forHTTPHeaderField: key)
        }
        
        // Add body if provided
        if let body = body {
            request.httpBody = body
        }
        
        return request
    }
    
    // MARK: - Request Execution with Retry
    
    /// Execute a request with retry logic
    private func executeRequest<T: Decodable>(
        _ request: URLRequest,
        responseType: T.Type,
        retryCount: Int = 0
    ) async throws -> T {
        do {
            let (data, response) = try await session.data(for: request)
            
            guard let httpResponse = response as? HTTPURLResponse else {
                throw APIError.networkError("Invalid response")
            }
            
            // Check for client errors that shouldn't be retried
            if httpResponse.statusCode < 500 && ![401, 408, 429].contains(httpResponse.statusCode) {
                if httpResponse.statusCode >= 400 {
                    let error = try? JSONDecoder().decode(APIError.self, from: data)
                    throw APIError.httpError(httpResponse.statusCode, error?.message ?? "Request failed")
                }
            }
            
            // Retry logic for network errors and specific status codes
            if retryCount < maxRetries {
                let shouldRetry = httpResponse.statusCode >= 500 ||
                                 httpResponse.statusCode == 408 ||
                                 httpResponse.statusCode == 429
                
                if shouldRetry {
                    let delay = retryDelay * pow(2.0, Double(retryCount))
                    try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                    return try await executeRequest(request, responseType: responseType, retryCount: retryCount + 1)
                }
            }
            
            // Handle 401 Unauthorized
            if httpResponse.statusCode == 401 {
                // Clear session token
                keychainService.deleteSessionToken()
                let error = try? JSONDecoder().decode(APIError.self, from: data)
                throw APIError.unauthorized(error?.message ?? "Session expired")
            }
            
            // Decode response
            if httpResponse.statusCode >= 200 && httpResponse.statusCode < 300 {
                let decoder = JSONDecoder()
                decoder.keyDecodingStrategy = .convertFromSnakeCase
                return try decoder.decode(T.self, from: data)
            } else {
                let error = try? JSONDecoder().decode(APIError.self, from: data)
                throw APIError.httpError(httpResponse.statusCode, error?.message ?? "Request failed")
            }
        } catch let error as APIError {
            throw error
        } catch {
            // Network error - retry if possible
            if retryCount < maxRetries {
                let delay = retryDelay * pow(2.0, Double(retryCount))
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                return try await executeRequest(request, responseType: responseType, retryCount: retryCount + 1)
            }
            throw APIError.networkError(error.localizedDescription)
        }
    }
    
    // MARK: - Auth Endpoints
    
    /// Exchange OAuth code for session
    func googleCallback(code: String) async throws -> AuthResponse {
        let body = ["code": code]
        let bodyData = try JSONEncoder().encode(body)
        
        guard let request = buildRequest(
            endpoint: "/auth/google/callback",
            method: "POST",
            body: bodyData,
            headers: ["X-Platform": "ios"]
        ) else {
            throw APIError.networkError("Invalid request")
        }
        
        return try await executeRequest(request, responseType: AuthResponse.self)
    }
    
    /// Add Google account
    func addGoogleAccount(code: String) async throws -> AuthResponse {
        let body = ["code": code]
        let bodyData = try JSONEncoder().encode(body)
        
        guard let request = buildRequest(
            endpoint: "/auth/google/add-account",
            method: "POST",
            body: bodyData
        ) else {
            throw APIError.networkError("Invalid request")
        }
        
        return try await executeRequest(request, responseType: AuthResponse.self)
    }
    
    /// Get current user
    func getCurrentUser() async throws -> CurrentUserResponse {
        guard let request = buildRequest(endpoint: "/auth/me") else {
            throw APIError.networkError("Invalid request")
        }
        
        return try await executeRequest(request, responseType: CurrentUserResponse.self)
    }
    
    /// Logout
    func logout() async throws -> [String: Bool] {
        guard let request = buildRequest(
            endpoint: "/auth/logout",
            method: "POST"
        ) else {
            throw APIError.networkError("Invalid request")
        }
        
        return try await executeRequest(request, responseType: [String: Bool].self)
    }
    
    // MARK: - Account Endpoints
    
    /// Get connected accounts
    func getAccounts() async throws -> AccountsResponse {
        guard let request = buildRequest(endpoint: "/api/accounts") else {
            throw APIError.networkError("Invalid request")
        }
        
        return try await executeRequest(request, responseType: AccountsResponse.self)
    }
    
    /// Delete account
    func deleteAccount(accountId: String) async throws -> [String: String] {
        guard let request = buildRequest(
            endpoint: "/api/accounts/\(accountId)",
            method: "DELETE"
        ) else {
            throw APIError.networkError("Invalid request")
        }
        
        return try await executeRequest(request, responseType: [String: String].self)
    }
    
    /// Set primary account
    func setPrimaryAccount(accountId: String) async throws -> [String: AnyCodable] {
        guard let request = buildRequest(
            endpoint: "/api/accounts/\(accountId)/set-primary",
            method: "PUT"
        ) else {
            throw APIError.networkError("Invalid request")
        }
        
        return try await executeRequest(request, responseType: [String: AnyCodable].self)
    }
    
    // MARK: - Meeting Endpoints
    
    /// Get meetings for a specific date
    func getMeetingsForDay(date: String) async throws -> MeetingsResponse {
        guard let url = URL(string: "\(baseURL)/api/meetings-for-day?date=\(date)") else {
            throw APIError.networkError("Invalid URL")
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("ios", forHTTPHeaderField: "X-Platform")
        
        if let sessionToken = keychainService.getSessionToken() {
            request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        }
        
        return try await executeRequest(request, responseType: MeetingsResponse.self)
    }
    
    /// Prep meeting (streaming response)
    func prepMeeting(meeting: Meeting, attendees: [Attendee], accessToken: String?) async throws -> [String: AnyCodable] {
        var body: [String: Any] = [
            "meeting": meeting,
            "attendees": attendees
        ]
        if let accessToken = accessToken {
            body["accessToken"] = accessToken
        }
        
        let bodyData = try JSONEncoder().encode(body)
        
        guard let request = buildRequest(
            endpoint: "/api/prep-meeting",
            method: "POST",
            body: bodyData
        ) else {
            throw APIError.networkError("Invalid request")
        }
        
        // For streaming, we'll handle it differently
        // For now, return the final result
        return try await executeRequest(request, responseType: [String: AnyCodable].self)
    }
    
    // MARK: - Chat Endpoints
    
    /// Get chat messages
    func getChatMessages(meetingId: String? = nil, limit: Int = 100) async throws -> ChatMessagesResponse {
        var queryItems = [URLQueryItem(name: "limit", value: "\(limit)")]
        if let meetingId = meetingId {
            queryItems.append(URLQueryItem(name: "meeting_id", value: meetingId))
        }
        
        var components = URLComponents(string: "\(baseURL)/api/chat/messages")
        components?.queryItems = queryItems
        
        guard let url = components?.url else {
            throw APIError.networkError("Invalid URL")
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("ios", forHTTPHeaderField: "X-Platform")
        
        if let sessionToken = keychainService.getSessionToken() {
            request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        }
        
        return try await executeRequest(request, responseType: ChatMessagesResponse.self)
    }
    
    /// Send chat message
    func sendChatMessage(message: String, meetingId: String? = nil) async throws -> [String: AnyCodable] {
        var body: [String: Any] = ["message": message]
        if let meetingId = meetingId {
            body["meeting_id"] = meetingId
        }
        
        let bodyData = try JSONEncoder().encode(body)
        
        guard let request = buildRequest(
            endpoint: "/api/chat/messages",
            method: "POST",
            body: bodyData
        ) else {
            throw APIError.networkError("Invalid request")
        }
        
        // Increase timeout for chat messages (can take up to 3 minutes)
        var mutableRequest = request
        mutableRequest.timeoutInterval = 180.0
        
        return try await executeRequest(mutableRequest, responseType: [String: AnyCodable].self)
    }
    
    /// Delete chat message
    func deleteChatMessage(messageId: String) async throws -> [String: Bool] {
        guard let request = buildRequest(
            endpoint: "/api/chat/messages/\(messageId)",
            method: "DELETE"
        ) else {
            throw APIError.networkError("Invalid request")
        }
        
        return try await executeRequest(request, responseType: [String: Bool].self)
    }
    
    // MARK: - Device Endpoints
    
    /// Register device for push notifications
    func registerDevice(deviceToken: String, platform: String = "ios", timezone: String, deviceInfo: DeviceInfo? = nil) async throws -> DeviceRegistrationResponse {
        let body = DeviceRegistrationRequest(
            device_token: deviceToken,
            platform: platform,
            timezone: timezone,
            device_info: deviceInfo
        )
        
        let bodyData = try JSONEncoder().encode(body)
        
        guard let request = buildRequest(
            endpoint: "/api/devices/register",
            method: "POST",
            body: bodyData
        ) else {
            throw APIError.networkError("Invalid request")
        }
        
        return try await executeRequest(request, responseType: DeviceRegistrationResponse.self)
    }
    
    // MARK: - Day Prep Endpoint
    
    /// Get day prep
    func dayPrep(date: String) async throws -> DayPrepResponse {
        let body = ["date": date]
        let bodyData = try JSONEncoder().encode(body)
        
        guard let request = buildRequest(
            endpoint: "/api/day-prep",
            method: "POST",
            body: bodyData
        ) else {
            throw APIError.networkError("Invalid request")
        }
        
        // Increase timeout for day prep (can take up to 5 minutes)
        var mutableRequest = request
        mutableRequest.timeoutInterval = 300.0
        
        return try await executeRequest(mutableRequest, responseType: DayPrepResponse.self)
    }
}

// MARK: - API Error Types

enum APIError: Error {
    case networkError(String)
    case httpError(Int, String)
    case unauthorized(String)
    case decodingError(String)
    
    var message: String {
        switch self {
        case .networkError(let msg):
            return msg
        case .httpError(let code, let msg):
            return "HTTP \(code): \(msg)"
        case .unauthorized(let msg):
            return msg
        case .decodingError(let msg):
            return "Decoding error: \(msg)"
        }
    }
}

