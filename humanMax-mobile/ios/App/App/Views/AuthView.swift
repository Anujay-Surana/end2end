import SwiftUI

struct AuthView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @State private var appeared = false
    @State private var buttonPressed = false
    
    var body: some View {
        ZStack {
            // Background - Pure black
            Color.black
                .ignoresSafeArea()
            
            VStack(spacing: 0) {
                Spacer()
                
                // Logo Section
                VStack(spacing: 32) {
                    // SHADOW wordmark with letter spacing
                    HStack(spacing: 12) {
                        ForEach(Array("SHADOW".enumerated()), id: \.offset) { index, letter in
                            Text(String(letter))
                                .font(.system(size: 42, weight: .light, design: .default))
                                .foregroundColor(.white)
                                .opacity(appeared ? 1 : 0)
                                .offset(y: appeared ? 0 : 20)
                                .animation(
                                    .easeOut(duration: 0.6).delay(Double(index) * 0.08),
                                    value: appeared
                                )
                        }
                    }
                    .padding(.bottom, 8)
                    
                    // Tagline
                    Text("Your AI meeting companion")
                        .font(.system(size: 16, weight: .regular, design: .default))
                        .foregroundColor(Color.white.opacity(0.5))
                        .tracking(1.5)
                        .opacity(appeared ? 1 : 0)
                        .animation(.easeOut(duration: 0.6).delay(0.5), value: appeared)
                }
                
                Spacer()
                
                // Features preview (subtle)
                VStack(spacing: 20) {
                    FeatureRow(icon: "calendar", text: "Smart calendar sync")
                    FeatureRow(icon: "mic.fill", text: "Real-time transcription")
                    FeatureRow(icon: "brain.head.profile", text: "AI-powered insights")
                }
                .opacity(appeared ? 1 : 0)
                .animation(.easeOut(duration: 0.6).delay(0.7), value: appeared)
                
                Spacer()
                
                // Sign in section
                VStack(spacing: 24) {
                    // Google Sign In Button
                    Button(action: {
                        buttonPressed = true
                        Task {
                            await authViewModel.signIn()
                            buttonPressed = false
                        }
                    }) {
                        HStack(spacing: 12) {
                            // Google "G" logo
                            ZStack {
                                Circle()
                                    .fill(Color.white)
                                    .frame(width: 24, height: 24)
                                
                                Text("G")
                                    .font(.system(size: 14, weight: .bold, design: .default))
                                    .foregroundStyle(
                                        LinearGradient(
                                            colors: [.red, .yellow, .green, .blue],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing
                                        )
                                    )
                            }
                            
                            Text("Continue with Google")
                                .font(.system(size: 17, weight: .medium, design: .default))
                                .foregroundColor(.black)
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 56)
                        .background(Color.white)
                        .cornerRadius(28)
                        .scaleEffect(buttonPressed ? 0.97 : 1.0)
                        .animation(.easeInOut(duration: 0.1), value: buttonPressed)
                    }
                    .disabled(authViewModel.isLoading)
                    .opacity(authViewModel.isLoading ? 0.7 : 1.0)
                    
                    // Loading indicator
                    if authViewModel.isLoading {
                        HStack(spacing: 8) {
                            ProgressView()
                                .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                .scaleEffect(0.8)
                            Text("Signing in...")
                                .font(.system(size: 14, weight: .regular))
                                .foregroundColor(Color.white.opacity(0.6))
                        }
                    }
                    
                    // Error message
                    if let error = authViewModel.errorMessage {
                        Text(error)
                            .font(.system(size: 13, weight: .regular))
                            .foregroundColor(Color.red.opacity(0.9))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 20)
                    }
                    
                    // Privacy note
                    Text("By continuing, you agree to Shadow's\nTerms of Service and Privacy Policy")
                        .font(.system(size: 12, weight: .regular))
                        .foregroundColor(Color.white.opacity(0.3))
                        .multilineTextAlignment(.center)
                        .lineSpacing(4)
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 50)
                .opacity(appeared ? 1 : 0)
                .offset(y: appeared ? 0 : 30)
                .animation(.easeOut(duration: 0.6).delay(0.9), value: appeared)
            }
        }
        .onAppear {
            withAnimation {
                appeared = true
            }
        }
    }
}

// Feature row component
struct FeatureRow: View {
    let icon: String
    let text: String
    
    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .light))
                .foregroundColor(Color.white.opacity(0.4))
                .frame(width: 24)
            
            Text(text)
                .font(.system(size: 15, weight: .regular))
                .foregroundColor(Color.white.opacity(0.5))
                .tracking(0.5)
            
            Spacer()
        }
        .padding(.horizontal, 48)
    }
}

#Preview {
    AuthView()
        .environmentObject(AuthViewModel())
}
