import SwiftUI

/// Live caption display for real-time transcription
/// Shows both user speech and AI response transcripts
struct LiveCaptionView: View {
    let userTranscript: String
    let assistantTranscript: String
    let partialTranscript: String
    let isSpeaking: Bool
    let isAssistantResponding: Bool
    
    var userColor: Color = .blue
    var assistantColor: Color = .green
    var maxHeight: CGFloat = 200
    
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    // User transcript
                    if !userTranscript.isEmpty || isSpeaking {
                        CaptionBubble(
                            text: userTranscript.isEmpty ? partialTranscript : userTranscript,
                            isPartial: userTranscript.isEmpty && isSpeaking,
                            source: .user,
                            color: userColor
                        )
                        .id("user")
                    }
                    
                    // Partial transcript (while speaking)
                    if isSpeaking && !partialTranscript.isEmpty && !userTranscript.isEmpty {
                        CaptionBubble(
                            text: partialTranscript,
                            isPartial: true,
                            source: .user,
                            color: userColor.opacity(0.7)
                        )
                        .id("partial-user")
                    }
                    
                    // Assistant transcript
                    if !assistantTranscript.isEmpty || isAssistantResponding {
                        CaptionBubble(
                            text: assistantTranscript.isEmpty ? partialTranscript : assistantTranscript,
                            isPartial: assistantTranscript.isEmpty && isAssistantResponding,
                            source: .assistant,
                            color: assistantColor
                        )
                        .id("assistant")
                    }
                    
                    // Partial transcript (while responding)
                    if isAssistantResponding && !partialTranscript.isEmpty && !assistantTranscript.isEmpty {
                        CaptionBubble(
                            text: partialTranscript,
                            isPartial: true,
                            source: .assistant,
                            color: assistantColor.opacity(0.7)
                        )
                        .id("partial-assistant")
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
            .frame(maxHeight: maxHeight)
            .onChange(of: partialTranscript) { _ in
                withAnimation(.easeOut(duration: 0.2)) {
                    if isAssistantResponding {
                        proxy.scrollTo("partial-assistant", anchor: .bottom)
                    } else if isSpeaking {
                        proxy.scrollTo("partial-user", anchor: .bottom)
                    }
                }
            }
        }
    }
}

/// Individual caption bubble
struct CaptionBubble: View {
    let text: String
    let isPartial: Bool
    let source: CaptionSource
    let color: Color
    
    var body: some View {
        HStack {
            if source == .assistant {
                Spacer(minLength: 40)
            }
            
            VStack(alignment: source == .user ? .leading : .trailing, spacing: 4) {
                // Source label
                HStack(spacing: 4) {
                    if source == .user {
                        Image(systemName: "person.fill")
                            .font(.caption2)
                        Text("You")
                            .font(.caption2)
                    } else {
                        Text("Shadow")
                            .font(.caption2)
                        Image(systemName: "waveform")
                            .font(.caption2)
                    }
                }
                .foregroundColor(color.opacity(0.8))
                
                // Caption text
                HStack(alignment: .bottom, spacing: 4) {
                    Text(text)
                        .font(.body)
                        .foregroundColor(.primary)
                    
                    if isPartial {
                        TypingIndicator()
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(color.opacity(0.15))
                .cornerRadius(16)
            }
            
            if source == .user {
                Spacer(minLength: 40)
            }
        }
    }
}

/// Caption source identifier
enum CaptionSource {
    case user
    case assistant
}

/// Typing indicator animation
struct TypingIndicator: View {
    @State private var dotOpacities: [Double] = [0.3, 0.3, 0.3]
    
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.primary)
                    .frame(width: 6, height: 6)
                    .opacity(dotOpacities[index])
            }
        }
        .onAppear {
            animateDots()
        }
    }
    
    private func animateDots() {
        for index in 0..<3 {
            withAnimation(
                Animation
                    .easeInOut(duration: 0.4)
                    .repeatForever()
                    .delay(Double(index) * 0.2)
            ) {
                dotOpacities[index] = 1.0
            }
        }
    }
}

/// Compact caption view (single line with scroll)
struct CompactCaptionView: View {
    let text: String
    let isPartial: Bool
    let source: CaptionSource
    
    var body: some View {
        HStack(spacing: 8) {
            // Source icon
            Image(systemName: source == .user ? "person.fill" : "waveform")
                .font(.caption)
                .foregroundColor(source == .user ? .blue : .green)
            
            // Caption text
            Text(text)
                .font(.subheadline)
                .lineLimit(2)
                .foregroundColor(.primary)
            
            if isPartial {
                TypingIndicator()
            }
            
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.systemGray6))
        .cornerRadius(8)
    }
}

/// Full transcript history view
struct TranscriptHistoryView: View {
    let messages: [TranscriptMessage]
    var userColor: Color = .blue
    var assistantColor: Color = .green
    
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(messages) { message in
                        CaptionBubble(
                            text: message.text,
                            isPartial: false,
                            source: message.isUser ? .user : .assistant,
                            color: message.isUser ? userColor : assistantColor
                        )
                        .id(message.id)
                    }
                }
                .padding()
            }
            .onChange(of: messages.count) { _ in
                if let lastMessage = messages.last {
                    withAnimation {
                        proxy.scrollTo(lastMessage.id, anchor: .bottom)
                    }
                }
            }
        }
    }
}

/// Transcript message model
struct TranscriptMessage: Identifiable {
    let id = UUID()
    let text: String
    let isUser: Bool
    let timestamp: Date
    
    init(text: String, isUser: Bool, timestamp: Date = Date()) {
        self.text = text
        self.isUser = isUser
        self.timestamp = timestamp
    }
}

// MARK: - Previews

#Preview("Live Captions") {
    LiveCaptionView(
        userTranscript: "Hello, can you help me prepare for my meeting?",
        assistantTranscript: "Of course! I'd be happy to help you prepare for your meeting. Could you tell me more about it?",
        partialTranscript: "",
        isSpeaking: false,
        isAssistantResponding: false
    )
    .padding()
}

#Preview("Speaking State") {
    LiveCaptionView(
        userTranscript: "",
        assistantTranscript: "",
        partialTranscript: "I need to prepare for...",
        isSpeaking: true,
        isAssistantResponding: false
    )
    .padding()
}

#Preview("Responding State") {
    LiveCaptionView(
        userTranscript: "What's on my calendar today?",
        assistantTranscript: "",
        partialTranscript: "Let me check your calendar...",
        isSpeaking: false,
        isAssistantResponding: true
    )
    .padding()
}

#Preview("Compact Caption") {
    CompactCaptionView(
        text: "Hello, how can I help you today?",
        isPartial: false,
        source: .assistant
    )
    .padding()
}

