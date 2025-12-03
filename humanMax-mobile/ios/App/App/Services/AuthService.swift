import Foundation
import AuthenticationServices
import UIKit

/// Authentication service handling OAuth flow and session management
@MainActor
class AuthService: NSObject, ObservableObject {
    static let shared = AuthService()
    
    @Published var currentUser: User?
    @Published var isAuthenticated: Bool = false
    
    private let apiClient: APIClient = APIClient.shared
    private let keychainService: KeychainService = KeychainService.shared
    private var authSession: ASWebAuthenticationSession?
    private var isProcessingCallback = false
    private var processedCodes: Set<String> = []
    
    private override init() {
        super.init()
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
        print("🔐 Starting OAuth flow with URL: \(oauthURL)")
        print("📱 Callback URL scheme: \(Constants.oauthRedirectScheme)")
        
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: oauthURL,
                callbackURLScheme: Constants.oauthRedirectScheme
            ) { [weak self] callbackURL, error in
                guard let self = self else { return }
                
                if let error = error {
                    print("❌ ASWebAuthenticationSession error: \(error)")
                    if let authError = error as? ASWebAuthenticationSessionError,
                       authError.code == .canceledLogin {
                        continuation.resume(throwing: AuthError.cancelled)
                    } else {
                        continuation.resume(throwing: AuthError.oauthError(error.localizedDescription))
                    }
                    return
                }
                
                guard let callbackURL = callbackURL else {
                    print("❌ No callback URL received from ASWebAuthenticationSession")
                    continuation.resume(throwing: AuthError.oauthError("No callback URL received"))
                    return
                }
                
                print("✅ ASWebAuthenticationSession received callback URL: \(callbackURL)")
                
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
        // Log received callback URL for debugging
        print("📱 Received OAuth callback URL: \(callbackURL)")
        
        // Parse URL components
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              let queryItems = components.queryItems else {
            print("❌ Failed to parse callback URL: \(callbackURL)")
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
        
        // Prevent duplicate processing of the same authorization code
        // OAuth codes are single-use, so processing the same code twice will fail
        if processedCodes.contains(code) {
            print("⚠️ Authorization code already processed, ignoring duplicate callback")
            // Return current user if already authenticated, otherwise throw error
            if let currentUser = currentUser {
                return currentUser
            }
            throw AuthError.oauthError("Authorization code already used")
        }
        
        // Check if we're already processing a callback
        guard !isProcessingCallback else {
            print("⚠️ OAuth callback already being processed, ignoring duplicate")
            // Wait a bit and check if we have a user
            try await Task.sleep(nanoseconds: 500_000_000) // 0.5 seconds
            if let currentUser = currentUser {
                return currentUser
            }
            throw AuthError.oauthError("OAuth callback already being processed")
        }
        
        isProcessingCallback = true
        defer {
            isProcessingCallback = false
        }
        
        // Verify state
        if let state = state {
            let storedState = UserDefaults.standard.string(forKey: "oauth_state")
            print("🔐 State validation - Received: \(state), Stored: \(storedState ?? "nil")")
            if storedState != state {
                UserDefaults.standard.removeObject(forKey: "oauth_state")
                print("❌ State mismatch!")
                throw AuthError.oauthError("Invalid OAuth state")
            }
            UserDefaults.standard.removeObject(forKey: "oauth_state")
            print("✅ State validated successfully")
        } else {
            print("⚠️ No state parameter in callback URL")
        }
        
        print("🔄 Exchanging code for session tokens...")
        // Exchange code for tokens
        let user = try await exchangeCodeForSession(code: code, state: state)
        
        // Mark code as processed after successful exchange
        processedCodes.insert(code)
        // Clean up old codes (keep last 10) - convert to array, remove oldest, recreate set
        if processedCodes.count > 10 {
            let codesArray = Array(processedCodes)
            processedCodes = Set(codesArray.suffix(10))
        }
        
        return user
    }
    
    /// Exchange OAuth code for session tokens
    private func exchangeCodeForSession(code: String, state: String?) async throws -> User {
        print("📡 Calling backend to exchange OAuth code...")
        let response = try await apiClient.googleCallback(code: code, state: state)
        
        print("📥 Backend response received - success: \(response.success)")
        
        guard response.success, let user = response.user else {
            let errorMsg = response.error ?? "Sign in failed"
            print("❌ Backend returned error: \(errorMsg)")
            throw AuthError.oauthError(errorMsg)
        }
        
        print("✅ Authentication successful for user: \(user.email)")
        
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
        if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let window = windowScene.windows.first {
            return window
        }
        return UIWindow()
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

