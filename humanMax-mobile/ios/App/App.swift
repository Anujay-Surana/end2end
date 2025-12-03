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
                    if url.scheme == Constants.oauthRedirectScheme {
                        Task { @MainActor in
                            do {
                                _ = try await AuthService.shared.handleOAuthCallback(callbackURL: url)
                                await authViewModel.checkSession()
                            } catch {
                                print("Error handling OAuth callback: \(error)")
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

