import Foundation
import SwiftUI

@MainActor
class ChatViewModel: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var isLoading = false
    @Published var isSending = false
    @Published var isRecording = false
    @Published var errorMessage: String?
    @Published var selectedMeeting: Meeting?
    @Published var cardMeeting: Meeting?
    @Published var generatingBrief = false
    
    /// Current meeting ID for voice context
    private var currentMeetingId: String?
    
    /// Streaming message IDs for real-time transcript display
    private var streamingUserMessageId: String?
    private var streamingAssistantMessageId: String?
    
    /// Index where the next user message should be inserted (before streaming assistant)
    /// This fixes message ordering since OpenAI sends assistant responses before user transcripts
    private var pendingUserMessageIndex: Int?
    
    /// Track last saved content to prevent duplicate saves
    private var lastSavedUserContent: String?
    private var lastSavedAssistantContent: String?
    
    private let apiClient = APIClient.shared
    private let voiceService = VoiceService.shared
    
    init() {
        setupVoiceServiceCallbacks()
    }
    
    /// Load messages - uses meeting-specific endpoint if meetingId is provided
    func loadMessages(meetingId: String? = nil) async {
        isLoading = true
        errorMessage = nil
        
        do {
            if let meetingId = meetingId {
                // Use meeting-specific endpoint
                let response = try await apiClient.getMeetingChat(meetingId: meetingId)
                messages = response.messages
            } else {
                // Use general chat endpoint
                let response = try await apiClient.getChatMessages(meetingId: nil)
                messages = response.messages
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        
        isLoading = false
    }
    
    /// Send message - uses meeting-specific endpoint if meetingId is provided
    /// Meeting-specific chat automatically injects brief context on the backend
    func sendMessage(_ text: String, meetingId: String? = nil) async {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        
        print("💬 Sending message: \(text.prefix(50))... meetingId: \(meetingId ?? "nil")")
        
        isSending = true
        errorMessage = nil
        
        // Add user message optimistically
        let optimisticUserMessage = ChatMessage(
            id: UUID().uuidString,
            role: "user",
            content: text,
            createdAt: ISO8601DateFormatter().string(from: Date()),
            meetingId: meetingId
        )
        messages.append(optimisticUserMessage)
        
        do {
            let response: ChatMessageSendResponse
            
            print("📤 Making API request...")
            let startTime = Date()
            
            if let meetingId = meetingId {
                // Use meeting-specific endpoint (auto-injects brief context)
                response = try await apiClient.sendMeetingChat(meetingId: meetingId, message: text)
            } else {
                // Use general chat endpoint
                response = try await apiClient.sendChatMessage(message: text, meetingId: nil)
            }
            
            let duration = Date().timeIntervalSince(startTime)
            print("📥 API response received in \(String(format: "%.1f", duration))s")
            print("   Success: \(response.success)")
            print("   Has userMessage: \(response.userMessage != nil)")
            print("   Has assistantMessage: \(response.assistantMessage != nil)")
            if let msg = response.assistantMessage {
                print("   Assistant response: \(msg.content.prefix(100))...")
            }
            
            // Replace optimistic message with actual user message from backend
            if let userMessage = response.userMessage {
                if let index = messages.firstIndex(where: { $0.id == optimisticUserMessage.id }) {
                    messages[index] = userMessage
                } else {
                    messages.append(userMessage)
                }
            }
            
            // Add assistant message
            if let assistantMessage = response.assistantMessage {
                messages.append(assistantMessage)
            }
            
            print("✅ Messages updated. Total: \(messages.count)")
        } catch {
            print("❌ Chat error: \(error)")
            errorMessage = error.localizedDescription
            // Remove optimistic message on error
            messages.removeAll { $0.id == optimisticUserMessage.id }
        }
        
        isSending = false
        print("💬 Send complete. isSending: \(isSending)")
    }
    
    func deleteMessage(_ messageId: String) async {
        do {
            _ = try await apiClient.deleteChatMessage(messageId: messageId)
            await loadMessages()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
    
    /// Start voice recording with optional meeting context
    /// - Parameter meetingId: Optional meeting ID for context injection in OpenAI Realtime
    func startVoiceRecording(meetingId: String? = nil) async {
        do {
            // Only update currentMeetingId if a new one is explicitly provided
            // Otherwise keep the one set by prepMeeting()
            if let meetingId = meetingId {
                currentMeetingId = meetingId
            }
            // Use currentMeetingId for the WebSocket connection
            print("🎤 Starting voice recording with meetingId: \(currentMeetingId ?? "nil")")
            try await voiceService.start(meetingId: currentMeetingId)
            isRecording = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }
    
    func stopVoiceRecording() async {
        await voiceService.stop()
        isRecording = false
        
        // Reset voice transcript tracking state
        streamingUserMessageId = nil
        streamingAssistantMessageId = nil
        pendingUserMessageIndex = nil
        lastSavedUserContent = nil
        lastSavedAssistantContent = nil
    }
    
    // MARK: - Voice Message Saving
    
    /// Save a message to the database without triggering AI response
    /// Used for voice transcripts and realtime AI responses
    private func saveMessageOnly(_ text: String, role: String, meetingId: String?) async {
        guard let meetingId = meetingId, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        
        do {
            _ = try await apiClient.saveChatMessage(message: text, role: role, meetingId: meetingId)
        } catch {
            print("⚠️ Failed to save voice message: \(error.localizedDescription)")
        }
    }
    
    func prepMeeting(_ meeting: Meeting) async {
        // Set meeting context for voice recording
        currentMeetingId = meeting.id
        selectedMeeting = meeting
        print("📋 prepMeeting: Set currentMeetingId = \(meeting.id)")
        
        generatingBrief = true
        errorMessage = nil
        
        do {
            let attendees = meeting.attendees ?? []
            let accessToken = AuthService.shared.getAccessToken()
            
            _ = try await apiClient.prepMeeting(
                meeting: meeting,
                attendees: attendees,
                accessToken: accessToken
            )
            
            // Reload messages to show prep result
            await loadMessages(meetingId: meeting.id)
        } catch {
            errorMessage = error.localizedDescription
        }
        
        generatingBrief = false
    }
    
    private func setupVoiceServiceCallbacks() {
        // Handle streaming transcripts from voice - both user and assistant
        // OpenAI sends assistant responses BEFORE user transcripts complete,
        // so we track insertion points to maintain correct message order
        voiceService.onTranscript = { [weak self] text, isFinal, source in
            Task { @MainActor in
                guard let self = self else { return }
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                
                let role = source == "user" ? "user" : "assistant"
                
                if source == "assistant" {
                    // ASSISTANT TRANSCRIPT
                    if isFinal {
                        // Final assistant transcript - update existing streaming message
                        if let existingId = self.streamingAssistantMessageId,
                           let index = self.messages.firstIndex(where: { $0.id == existingId }) {
                            self.messages[index] = ChatMessage(
                                id: existingId,
                                role: role,
                                content: text,
                                createdAt: self.messages[index].createdAt,
                                meetingId: self.currentMeetingId
                            )
                        }
                        self.streamingAssistantMessageId = nil
                        
                        // Dedupe: only save if different from last saved
                        if self.lastSavedAssistantContent != text {
                            self.lastSavedAssistantContent = text
                            await self.saveMessageOnly(text, role: role, meetingId: self.currentMeetingId)
                        }
                    } else {
                        // Partial assistant transcript
                        if let existingId = self.streamingAssistantMessageId,
                           let index = self.messages.firstIndex(where: { $0.id == existingId }) {
                            // Append to existing streaming message
                            let existingContent = self.messages[index].content
                            self.messages[index] = ChatMessage(
                                id: existingId,
                                role: role,
                                content: existingContent + text,
                                createdAt: self.messages[index].createdAt,
                                meetingId: self.currentMeetingId
                            )
                        } else {
                            // First partial - record insertion index for user message
                            // User message should appear BEFORE this assistant message
                            if self.pendingUserMessageIndex == nil {
                                self.pendingUserMessageIndex = self.messages.count
                                print("📍 Recorded pending user message index: \(self.messages.count)")
                            }
                            
                            // Create new streaming assistant message
                            let newId = UUID().uuidString
                            self.streamingAssistantMessageId = newId
                            self.messages.append(ChatMessage(
                                id: newId,
                                role: role,
                                content: text,
                                createdAt: ISO8601DateFormatter().string(from: Date()),
                                meetingId: self.currentMeetingId
                            ))
                        }
                    }
                } else {
                    // USER TRANSCRIPT
                    if isFinal {
                        // Dedupe: skip if same as last saved user content
                        if self.lastSavedUserContent == text {
                            print("⚠️ Skipping duplicate user transcript: \(text.prefix(30))...")
                            return
                        }
                        
                        // Create the user message
                        let userMessage = ChatMessage(
                            id: UUID().uuidString,
                            role: role,
                            content: text,
                            createdAt: ISO8601DateFormatter().string(from: Date()),
                            meetingId: self.currentMeetingId
                        )
                        
                        // Insert at correct position (before assistant response) if we have a pending index
                        if let insertIndex = self.pendingUserMessageIndex, insertIndex <= self.messages.count {
                            print("📍 Inserting user message at index \(insertIndex) (before assistant)")
                            self.messages.insert(userMessage, at: insertIndex)
                            self.pendingUserMessageIndex = nil
                        } else {
                            // No pending index, just append
                            self.messages.append(userMessage)
                        }
                        
                        self.streamingUserMessageId = nil
                        
                        // Save to database
                        self.lastSavedUserContent = text
                        await self.saveMessageOnly(text, role: role, meetingId: self.currentMeetingId)
                    }
                    // Note: We don't handle partial user transcripts since OpenAI only sends final user transcripts
                }
            }
        }
        
        // onResponse is now handled by onTranscript for assistant messages
        // Keep this for backwards compatibility with any direct text responses
        voiceService.onResponse = { [weak self] text in
            Task { @MainActor in
                guard let self = self else { return }
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                
                // Only add if not already present (avoid duplicates with transcript)
                let recentMessages = self.messages.suffix(5)
                let alreadyExists = recentMessages.contains { $0.role == "assistant" && $0.content == text }
                
                if !alreadyExists {
                    let assistantMessage = ChatMessage(
                        id: UUID().uuidString,
                        role: "assistant",
                        content: text,
                        createdAt: ISO8601DateFormatter().string(from: Date()),
                        meetingId: self.currentMeetingId
                    )
                    self.messages.append(assistantMessage)
                    await self.saveMessageOnly(text, role: "assistant", meetingId: self.currentMeetingId)
                }
            }
        }
        
        voiceService.onError = { [weak self] error in
            Task { @MainActor in
                self?.errorMessage = error.localizedDescription
                self?.isRecording = false
            }
        }
    }
}

