import SwiftUI

struct ListeningView: View {
    let meeting: Meeting
    @Environment(\.dismiss) private var dismiss
    @State private var elapsedSeconds = 0
    @State private var isActive = true
    @State private var pulseAnimation = false
    
    let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
    
    var body: some View {
        ZStack {
            // Background gradient
            LinearGradient(
                gradient: Gradient(colors: [
                    Color(red: 0.04, green: 0.04, blue: 0.04),
                    Color(red: 0.1, green: 0.1, blue: 0.18),
                    Color(red: 0.09, green: 0.13, blue: 0.24)
                ]),
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()
            
            VStack(spacing: 32) {
                // Header
                VStack(spacing: 8) {
                    Text(meeting.summary)
                        .font(.title2)
                        .fontWeight(.semibold)
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                    
                    // Status badge
                    HStack(spacing: 6) {
                        Circle()
                            .fill(Color.green)
                            .frame(width: 8, height: 8)
                            .opacity(pulseAnimation ? 0.4 : 1.0)
                            .animation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true), value: pulseAnimation)
                        
                        Text("Listening")
                            .font(.subheadline)
                            .foregroundColor(Color.green)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.1))
                    .cornerRadius(20)
                }
                .padding(.top, 60)
                
                Spacer()
                
                // Aura Ball
                ZStack {
                    // Outer rings
                    ForEach(0..<3, id: \.self) { index in
                        Circle()
                            .stroke(
                                LinearGradient(
                                    gradient: Gradient(colors: [
                                        Color(red: 0.39, green: 0.4, blue: 0.95).opacity(0.3 - Double(index) * 0.1),
                                        Color(red: 0.55, green: 0.36, blue: 0.97).opacity(0.4 - Double(index) * 0.1)
                                    ]),
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                ),
                                lineWidth: 2
                            )
                            .frame(width: 200 - CGFloat(index * 50), height: 200 - CGFloat(index * 50))
                            .scaleEffect(pulseAnimation ? 1.1 : 1.0)
                            .animation(
                                .easeInOut(duration: 3)
                                .repeatForever(autoreverses: true)
                                .delay(Double(index) * 0.5),
                                value: pulseAnimation
                            )
                    }
                    
                    // Core glow
                    Circle()
                        .fill(
                            RadialGradient(
                                gradient: Gradient(colors: [
                                    Color(red: 0.55, green: 0.36, blue: 0.97),
                                    Color(red: 0.39, green: 0.4, blue: 0.95),
                                    Color(red: 0.65, green: 0.55, blue: 0.98)
                                ]),
                                center: .center,
                                startRadius: 0,
                                endRadius: 30
                            )
                        )
                        .frame(width: 60, height: 60)
                        .shadow(color: Color(red: 0.39, green: 0.4, blue: 0.95).opacity(0.5), radius: 30)
                        .shadow(color: Color(red: 0.55, green: 0.36, blue: 0.97).opacity(0.3), radius: 60)
                        .shadow(color: Color(red: 0.65, green: 0.55, blue: 0.98).opacity(0.2), radius: 100)
                        .scaleEffect(pulseAnimation ? 1.05 : 1.0)
                        .animation(.easeInOut(duration: 2).repeatForever(autoreverses: true), value: pulseAnimation)
                }
                .frame(width: 200, height: 200)
                
                Spacer()
                
                // Status text
                VStack(spacing: 12) {
                    Text("Listening to your meeting")
                        .font(.title2)
                        .fontWeight(.medium)
                        .foregroundColor(.white)
                    
                    Text(formattedElapsedTime)
                        .font(.system(size: 48, weight: .semibold, design: .rounded))
                        .foregroundColor(.white)
                        .monospacedDigit()
                    
                    Text("Shadow is capturing key moments and insights")
                        .font(.subheadline)
                        .foregroundColor(.white.opacity(0.6))
                        .multilineTextAlignment(.center)
                }
                
                Spacer()
                
                // End Session Button
                Button(action: {
                    isActive = false
                    dismiss()
                }) {
                    Text("End Session")
                        .font(.headline)
                        .fontWeight(.medium)
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.white.opacity(0.1))
                        .cornerRadius(12)
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(Color.white.opacity(0.2), lineWidth: 1)
                        )
                }
                .padding(.horizontal)
                .padding(.bottom, 32)
            }
        }
        .onAppear {
            pulseAnimation = true
        }
        .onReceive(timer) { _ in
            if isActive {
                elapsedSeconds += 1
            }
        }
    }
    
    private var formattedElapsedTime: String {
        let hours = elapsedSeconds / 3600
        let minutes = (elapsedSeconds % 3600) / 60
        let seconds = elapsedSeconds % 60
        
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%d:%02d", minutes, seconds)
    }
}

#Preview {
    let sampleMeeting = Meeting(
        id: "1",
        summary: "Q4 Planning Session",
        title: nil,
        description: nil,
        start: nil,
        end: nil,
        attendees: nil,
        location: nil,
        htmlLink: nil,
        accountEmail: nil,
        brief: nil
    )
    
    return ListeningView(meeting: sampleMeeting)
}
