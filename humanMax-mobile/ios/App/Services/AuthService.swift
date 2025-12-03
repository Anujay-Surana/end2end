import Foundation
import AuthenticationServices
import UIKit

/// Authentication service handling OAuth flow and session management
@MainActor
class AuthService: ObservableObject {
    static let shared = AuthService()
    
    @Published var currentUser: User?
    @Published var isAuthenticated: Bool = false
    
    private let apiClient: APIClient
    private let keychainService: KeychainService
    private var authSession: ASWebAuthenticationSession?
    
    private init() {
        self.apiClient = APIClient.shared
        self.keychainService = KeychainService.shared
        loadStoredUser()
    }
    
    // MARK: - OAuth Flow
    
    /// Sign in with Google OAuth
    func signIn() async throws -> User {
        guard !Constants.googleClientID.isEmpty else {
            throw AuthError.configurationError("Google OAuth Client ID is not configured")
        }
        
        // Generate state for CSRF protection
        let state = UUID().uuidString
        UserDefaults.standard.set(state, forKey: "oauth_state")
        
        // Build OAuth URL
        let redirectURI = Constants.oauthRedirectURI
        let scopes = Constants.oauthScopes.joined(separator: " ")
        
        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: Constants.googleClientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: scopes),
            URLQueryItem(name: "access_type", value: "offline"),
            URLQueryItem(name: "prompt", value: "consent"),
            URLQueryItem(name: "state", value: state)
        ]
        
        guard let oauthURL = components.url else {
            throw AuthError.configurationError("Invalid OAuth URL")
        }
        
        // Use ASWebAuthenticationSession for OAuth
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: oauthURL,
                callbackURLScheme: Constants.oauthRedirectScheme
            ) { [weak self] callbackURL, error in
                guard let self = self else { return }
                
                if let error = error {
                    if let authError = error as? ASWebAuthenticationSessionError,
                       authError.code == .canceledLogin {
                        continuation.resume(throwing: AuthError.cancelled)
                    } else {
                        continuation.resume(throwing: AuthError.oauthError(error.localizedDescription))
                    }
                    return
                }
                
                guard let callbackURL = callbackURL else {
                    continuation.resume(throwing: AuthError.oauthError("No callback URL received"))
                    return
                }
                
                // Handle OAuth callback
                Task {
                    do {
                        let user = try await self.handleOAuthCallback(callbackURL: callbackURL)
                        continuation.resume(returning: user)
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
            
            // Set presentation context provider
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            
            self.authSession = session
            session.start()
        }
    }
    
    /// Handle OAuth callback from deep link
    func handleOAuthCallback(callbackURL: URL) async throws -> User {
        // Parse URL components
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              let queryItems = components.queryItems else {
            throw AuthError.oauthError("Invalid callback URL")
        }
        
        // Extract code and state
        var code: String?
        var state: String?
        var error: String?
        
        for item in queryItems {
            switch item.name {
            case "code":
                code = item.value
            case "state":
                state = item.value
            case "error":
                error = item.value
            default:
                break
            }
        }
        
        // Check for OAuth error
        if let error = error {
            throw AuthError.oauthError(error)
        }
        
        guard let code = code else {
            throw AuthError.oauthError("No authorization code received")
        }
        
        // Verify state
        if let state = state {
            let storedState = UserDefaults.standard.string(forKey: "oauth_state")
            if storedState != state {
                UserDefaults.standard.removeObject(forKey: "oauth_state")
                throw AuthError.oauthError("Invalid OAuth state")
            }
            UserDefaults.standard.removeObject(forKey: "oauth_state")
        }
        
        // Exchange code for tokens
        return try await exchangeCodeForSession(code: code)
    }
    
    /// Exchange OAuth code for session tokens
    private func exchangeCodeForSession(code: String) async throws -> User {
        let response = try await apiClient.googleCallback(code: code)
        
        guard response.success, let user = response.user else {
            throw AuthError.oauthError(response.error ?? "Sign in failed")
        }
        
        // Store tokens
        if let sessionToken = response.session?.token {
            _ = keychainService.storeSessionToken(sessionToken)
        }
        
        if let accessToken = response.access_token {
            _ = keychainService.storeAccessToken(accessToken)
        }
        
        // Store user info
        storeUser(user)
        
        // Update state
        await MainActor.run {
            self.currentUser = user
            self.isAuthenticated = true
        }
        
        return user
    }
    
    // MARK: - Session Management
    
    /// Check if user has valid session
    func checkSession() async throws -> User? {
        do {
            let response = try await apiClient.getCurrentUser()
            let user = response.user
            
            // Update stored user
            storeUser(user)
            
            await MainActor.run {
                self.currentUser = user
                self.isAuthenticated = true
            }
            
            return user
        } catch {
            // Session invalid or expired
            await MainActor.run {
                self.currentUser = nil
                self.isAuthenticated = false
            }
            
            // Clear stored data
            keychainService.clearAuthTokens()
            UserDefaults.standard.removeObject(forKey: "user")
            
            return nil
        }
    }
    
    /// Sign out
    func signOut() async {
        // Call backend logout endpoint
        try? await apiClient.logout()
        
        // Clear local data
        keychainService.clearAuthTokens()
        UserDefaults.standard.removeObject(forKey: "user")
        
        await MainActor.run {
            self.currentUser = nil
            self.isAuthenticated = false
        }
    }
    
    /// Load stored user from UserDefaults
    private func loadStoredUser() {
        guard let userData = UserDefaults.standard.data(forKey: "user"),
              let user = try? JSONDecoder().decode(User.self, from: userData) else {
            return
        }
        
        self.currentUser = user
        self.isAuthenticated = true
    }
    
    /// Store user in UserDefaults
    private func storeUser(_ user: User) {
        if let userData = try? JSONEncoder().encode(user) {
            UserDefaults.standard.set(userData, forKey: "user")
        }
    }
    
    /// Get current user (synchronous)
    func getCurrentUser() -> User? {
        return currentUser
    }
    
    /// Get access token
    func getAccessToken() -> String? {
        return keychainService.getAccessToken()
    }
}

// MARK: - ASWebAuthenticationPresentationContextProviding

extension AuthService: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return UIApplication.shared.windows.first { $0.isKeyWindow } ?? UIWindow()
    }
}

// MARK: - Auth Error Types

enum AuthError: Error, LocalizedError {
    case configurationError(String)
    case oauthError(String)
    case cancelled
    case networkError(String)
    
    var errorDescription: String? {
        switch self {
        case .configurationError(let msg):
            return "Configuration error: \(msg)"
        case .oauthError(let msg):
            return "OAuth error: \(msg)"
        case .cancelled:
            return "Sign in cancelled"
        case .networkError(let msg):
            return "Network error: \(msg)"
        }
    }
}

