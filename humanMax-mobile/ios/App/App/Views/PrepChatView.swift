import SwiftUI

struct PrepChatView: View {
    let meeting: Meeting
    @Environment(\.dismiss) private var dismiss
    @StateObject private var chatViewModel = ChatViewModel()
    @State private var inputText = ""
    @State private var showListening = false
    
    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                // Chat Messages
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            // Welcome message
                            if chatViewModel.messages.isEmpty {
                                PrepMessageBubble(
                                    content: "I'm ready to help you prepare for \"\(meeting.summary)\". You can ask me about the attendees, agenda, or any other questions you have about this meeting.",
                                    isUser: false
                                )
                            }
                            
                            ForEach(chatViewModel.messages) { message in
                                PrepMessageBubble(
                                    content: message.content,
                                    isUser: message.role == "user"
                                )
                                .id(message.id)
                            }
                            
                            if chatViewModel.isSending {
                                TypingIndicator()
                            }
                        }
                        .padding()
                    }
                    .onChange(of: chatViewModel.messages.count) { _ in
                        if let lastMessage = chatViewModel.messages.last {
                            withAnimation {
                                proxy.scrollTo(lastMessage.id, anchor: .bottom)
                            }
                        }
                    }
                }
                
                Divider()
                
                // Input Area
                HStack(spacing: 12) {
                    // Voice button
                    Button(action: {
                        Task {
                            if chatViewModel.isRecording {
                                await chatViewModel.stopVoiceRecording()
                            } else {
                                // Pass meeting.id for context injection
                                await chatViewModel.startVoiceRecording(meetingId: meeting.id)
                            }
                        }
                    }) {
                        Image(systemName: chatViewModel.isRecording ? "mic.fill" : "mic")
                            .foregroundColor(chatViewModel.isRecording ? .red : .blue)
                            .frame(width: 40, height: 40)
                            .background(
                                Circle()
                                    .fill(chatViewModel.isRecording ? Color.red.opacity(0.1) : Color.clear)
                            )
                    }
                    
                    // Text field
                    TextField("Ask about this meeting...", text: $inputText)
                        .textFieldStyle(RoundedBorderTextFieldStyle())
                        .onSubmit {
                            sendMessage()
                        }
                    
                    // Send button
                    Button(action: sendMessage) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                            .foregroundColor(inputText.isEmpty ? .gray : .blue)
                    }
                    .disabled(inputText.isEmpty || chatViewModel.isSending)
                }
                .padding()
                .background(Color(.systemBackground))
            }
            .navigationTitle(meeting.summary)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { dismiss() }) {
                        Image(systemName: "chevron.left")
                            .foregroundColor(.primary)
                    }
                }
                
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: {
                        showListening = true
                    }) {
                        Text("Listen In")
                            .font(.subheadline)
                            .fontWeight(.medium)
                            .foregroundColor(.white)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Color.black)
                            .cornerRadius(8)
                    }
                }
            }
        }
        .fullScreenCover(isPresented: $showListening) {
            ListeningView(meeting: meeting)
        }
        .task {
            // Load any existing messages for this meeting
            await chatViewModel.loadMessages(meetingId: meeting.id)
        }
    }
    
    private func sendMessage() {
        guard !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let text = inputText
        inputText = ""
        Task {
            await chatViewModel.sendMessage(text, meetingId: meeting.id)
        }
    }
}

// MARK: - Message Bubble for Prep

struct PrepMessageBubble: View {
    let content: String
    let isUser: Bool
    
    var body: some View {
        HStack {
            if isUser {
                Spacer()
            }
            
            Text(content)
                .padding(12)
                .background(isUser ? Color.black : Color.gray.opacity(0.15))
                .foregroundColor(isUser ? .white : .primary)
                .cornerRadius(18)
            
            if !isUser {
                Spacer()
            }
        }
        .frame(maxWidth: UIScreen.main.bounds.width * 0.85, alignment: isUser ? .trailing : .leading)
    }
}

// MARK: - Typing Indicator

struct TypingIndicator: View {
    @State private var animationOffset = 0
    
    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.gray)
                    .frame(width: 8, height: 8)
                    .offset(y: animationOffset == index ? -4 : 0)
            }
        }
        .padding(12)
        .background(Color.gray.opacity(0.15))
        .cornerRadius(18)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.5).repeatForever()) {
                animationOffset = (animationOffset + 1) % 3
            }
        }
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
        brief: nil,
        briefData: nil
    )
    
    return PrepChatView(meeting: sampleMeeting)
}
