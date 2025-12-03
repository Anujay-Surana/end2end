import SwiftUI

@main
struct ShadowApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var authViewModel = AuthViewModel()
    
    init() {
        // Initialize services on app launch
        Task { @MainActor in
            await NotificationService.shared.initialize()
            BackgroundSyncService.shared.initialize()
        }
    }
    
    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(authViewModel)
                .onOpenURL { url in
                    // Note: OAuth deep links are primarily handled in AppDelegate.application(_:open:options:)
                    // This handler is kept as a fallback, but AuthService.handleOAuthCallback() has
                    // deduplication logic to prevent processing the same authorization code twice.
                    if url.scheme == Constants.oauthRedirectScheme {
                        print("🔗 App received URL via onOpenURL (fallback handler): \(url)")
                        Task { @MainActor in
                            do {
                                _ = try await AuthService.shared.handleOAuthCallback(callbackURL: url)
                                await authViewModel.checkSession()
                                print("✅ OAuth callback handled successfully (fallback)")
                            } catch {
                                // Ignore "already processed" errors silently
                                if !error.localizedDescription.contains("already") {
                                    print("❌ Error handling OAuth callback: \(error)")
                                }
                            }
                        }
                    }
                }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    
    var body: some View {
        Group {
            if authViewModel.isLoading {
                ProgressView("Loading...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if authViewModel.isAuthenticated {
                MainTabView()
                    .environmentObject(authViewModel)
            } else {
                AuthView()
                    .environmentObject(authViewModel)
            }
        }
        .task {
            await authViewModel.checkSession()
        }
    }
}

struct MainTabView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var chatViewModel = ChatViewModel()
    @StateObject private var meetingsViewModel = MeetingsViewModel()
    
    var body: some View {
        TabView {
            HomeView()
                .environmentObject(meetingsViewModel)
                .tabItem {
                    Label("Home", systemImage: "house")
                }
            
            // Chat tab removed - chat is now meeting-specific only
            // Accessible via: Home -> Meeting -> Prep -> PrepChatView
            
            NotesView()
                .tabItem {
                    Label("Notes", systemImage: "note.text")
                }
            
            SettingsView()
                .environmentObject(authViewModel)
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
        }
        // Keep chatViewModel available for meeting-specific chat via environment
        .environmentObject(chatViewModel)
    }
}

