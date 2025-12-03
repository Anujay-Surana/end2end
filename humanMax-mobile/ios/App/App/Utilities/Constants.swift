import Foundation

/// Application constants
struct Constants {
    /// API base URL - can be overridden via environment variable
    static var apiBaseURL: String {
        // Check for environment variable first (for testing)
        if let envURL = ProcessInfo.processInfo.environment["API_BASE_URL"] {
            return envURL
        }
        // Production URL
        return "https://end2end-production.up.railway.app"
    }
    
    /// Google OAuth Client ID - should be set via environment variable or Info.plist
    static var googleClientID: String {
        // Check environment variable first
        if let clientID = ProcessInfo.processInfo.environment["GOOGLE_CLIENT_ID"] {
            return clientID
        }
        // Check Info.plist
        if let clientID = Bundle.main.object(forInfoDictionaryKey: "GoogleClientID") as? String {
            return clientID
        }
        // Return empty string if not configured
        return ""
    }
    
    /// OAuth scopes
    static let oauthScopes = [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/drive.readonly"
    ]
    
    /// OAuth redirect URI scheme
    static let oauthRedirectScheme = "com.kordn8.shadow"
    
    /// OAuth redirect URI path
    static let oauthRedirectPath = "/auth/google/mobile-callback"
    
    /// Full OAuth redirect URI
    static var oauthRedirectURI: String {
        return "\(apiBaseURL)\(oauthRedirectPath)"
    }
    
    /// WebSocket endpoint
    static var websocketURL: String {
        return apiBaseURL.replacingOccurrences(of: "http://", with: "ws://")
                         .replacingOccurrences(of: "https://", with: "wss://")
    }
    
    /// Realtime WebSocket endpoint
    static var realtimeWebSocketURL: String {
        return "\(websocketURL)/ws/realtime"
    }
}

