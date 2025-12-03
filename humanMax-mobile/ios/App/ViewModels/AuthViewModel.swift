import Foundation
import SwiftUI

@MainActor
class AuthViewModel: ObservableObject {
    @Published var isAuthenticated = false
    @Published var isLoading = true
    @Published var currentUser: User?
    @Published var errorMessage: String?
    
    private let authService = AuthService.shared
    
    init() {
        // Observe AuthService changes
        Task {
            await checkSession()
        }
    }
    
    func checkSession() async {
        isLoading = true
        errorMessage = nil
        
        do {
            if let user = try await authService.checkSession() {
                currentUser = user
                isAuthenticated = true
            } else {
                currentUser = nil
                isAuthenticated = false
            }
        } catch {
            errorMessage = error.localizedDescription
            currentUser = nil
            isAuthenticated = false
        }
        
        isLoading = false
    }
    
    func signIn() async {
        isLoading = true
        errorMessage = nil
        
        do {
            let user = try await authService.signIn()
            currentUser = user
            isAuthenticated = true
            
            // Send welcome message for first-time users
            await sendWelcomeMessageIfNeeded()
        } catch {
            errorMessage = error.localizedDescription
        }
        
        isLoading = false
    }
    
    func signOut() async {
        await authService.signOut()
        currentUser = nil
        isAuthenticated = false
    }
    
    private func sendWelcomeMessageIfNeeded() async {
        do {
            let response = try await APIClient.shared.getChatMessages(limit: 1)
            if response.messages.isEmpty {
                // First-time user - send welcome message
                _ = try await APIClient.shared.sendChatMessage(
                    message: "Welcome to Shadow. Your daily briefing will appear at 9 AM.",
                    meetingId: nil
                )
            }
        } catch {
            // Don't fail sign-in if welcome message fails
            print("Error sending welcome message: \(error)")
        }
    }
}

