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
                    // Handle OAuth deep link
                    print("🔗 App received URL via onOpenURL: \(url)")
                    if url.scheme == Constants.oauthRedirectScheme {
                        print("✅ URL scheme matches OAuth redirect scheme")
                        Task { @MainActor in
                            do {
                                _ = try await AuthService.shared.handleOAuthCallback(callbackURL: url)
                                await authViewModel.checkSession()
                                print("✅ OAuth callback handled successfully")
                            } catch {
                                print("❌ Error handling OAuth callback: \(error)")
                            }
                        }
                    } else {
                        print("⚠️ URL scheme mismatch - expected: \(Constants.oauthRedirectScheme), got: \(url.scheme ?? "nil")")
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
            CalendarView()
                .environmentObject(meetingsViewModel)
                .tabItem {
                    Label("Calendar", systemImage: "calendar")
                }
            
            ChatView()
                .environmentObject(chatViewModel)
                .tabItem {
                    Label("Chat", systemImage: "message")
                }
            
            SettingsView()
                .environmentObject(authViewModel)
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
        }
    }
}

