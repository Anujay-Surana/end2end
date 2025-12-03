import Foundation

/// User model matching backend structure
struct User: Codable, Identifiable {
    let id: String
    let email: String
    let name: String?
    let picture: String?
    let created_at: String?
    let updated_at: String?
}

/// Authentication response from backend
struct AuthResponse: Codable {
    let success: Bool
    let user: User?
    let access_token: String?
    let session: Session?
    let error: String?
}

/// Session model
struct Session: Codable {
    let token: String
    let expiresAt: String?
    let userId: String
    
    enum CodingKeys: String, CodingKey {
        case token
        case expiresAt = "expires_at"
        case userId = "user_id"
    }
}

/// OAuth callback request
struct OAuthCallbackRequest: Codable {
    let code: String
    let state: String?
}

/// Current user response
struct CurrentUserResponse: Codable {
    let user: User
    let accessToken: String?
}

/// Accounts response
struct AccountsResponse: Codable {
    let success: Bool
    let accounts: [Account]
}

/// Account model
struct Account: Codable, Identifiable {
    let id: String
    let provider: String
    let email: String?
    let name: String?
    let picture: String?
    let isPrimary: Bool
    let createdAt: String?
}

