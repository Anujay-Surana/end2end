import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @State private var accounts: [Account] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    
    var body: some View {
        NavigationView {
            List {
                Section(header: Text("Account")) {
                    if let user = authViewModel.currentUser {
                        HStack {
                            if let picture = user.picture, let url = URL(string: picture) {
                                AsyncImage(url: url) { image in
                                    image
                                        .resizable()
                                        .aspectRatio(contentMode: .fill)
                                } placeholder: {
                                    Image(systemName: "person.circle.fill")
                                        .foregroundColor(.gray)
                                }
                                .frame(width: 50, height: 50)
                                .clipShape(Circle())
                            } else {
                                Image(systemName: "person.circle.fill")
                                    .font(.system(size: 50))
                                    .foregroundColor(.gray)
                            }
                            
                            VStack(alignment: .leading) {
                                Text(user.name ?? user.email)
                                    .font(.headline)
                                Text(user.email)
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                }
                
                Section(header: Text("Connected Accounts")) {
                    if isLoading {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                    } else {
                        ForEach(accounts) { account in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(account.email ?? account.name ?? "Unknown")
                                        .font(.headline)
                                    Text(account.provider.capitalized)
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                
                                Spacer()
                                
                                if account.isPrimary {
                                    Text("Primary")
                                        .font(.caption)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 4)
                                        .background(Color.blue.opacity(0.2))
                                        .foregroundColor(.blue)
                                        .cornerRadius(4)
                                }
                            }
                        }
                        .onDelete(perform: deleteAccount)
                    }
                    
                    Button(action: addAccount) {
                        HStack {
                            Image(systemName: "plus.circle")
                            Text("Add Account")
                        }
                    }
                }
                
                Section {
                    Button(role: .destructive, action: {
                        Task {
                            await authViewModel.signOut()
                        }
                    }) {
                        HStack {
                            Spacer()
                            Text("Sign Out")
                            Spacer()
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .task {
                await loadAccounts()
            }
            .alert("Error", isPresented: .constant(errorMessage != nil)) {
                Button("OK") {
                    errorMessage = nil
                }
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }
    
    private func loadAccounts() async {
        isLoading = true
        errorMessage = nil
        
        do {
            let response = try await APIClient.shared.getAccounts()
            accounts = response.accounts
        } catch {
            errorMessage = error.localizedDescription
        }
        
        isLoading = false
    }
    
    private func addAccount() {
        Task {
            do {
                _ = try await AuthService.shared.signIn()
                await loadAccounts()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
    
    private func deleteAccount(at offsets: IndexSet) {
        Task {
            for index in offsets {
                let account = accounts[index]
                do {
                    _ = try await APIClient.shared.deleteAccount(accountId: account.id)
                    await loadAccounts()
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }
}

