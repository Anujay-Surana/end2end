import Foundation

/// User model matching backend structure
struct User: Codable, Identifiable {
    let id: String
    let email: String
    let name: String?
    let picture: String?
    let createdAt: String?
    let updatedAt: String?
}

/// Authentication response from backend
struct AuthResponse: Codable {
    let success: Bool
    let user: User?
    let accessToken: String?
    let session: Session?
    let error: String?
    let tokenExpiresAt: String?
}

/// Session model
/// Note: Using automatic snake_case conversion from JSONDecoder
/// So userId maps from "user_id", expiresAt from "expires_at" automatically
struct Session: Codable {
    let token: String
    let expiresAt: String?
    let userId: String?  // Made optional for safety
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
