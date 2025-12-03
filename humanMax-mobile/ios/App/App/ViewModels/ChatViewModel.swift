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
            currentMeetingId = meetingId
            try await voiceService.start(meetingId: meetingId)
            isRecording = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }
    
    func stopVoiceRecording() async {
        await voiceService.stop()
        isRecording = false
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
        // Handle user transcripts from voice
        // Now we show them in chat but DON'T call chat API (OpenAI Realtime handles response)
        voiceService.onTranscript = { [weak self] text, isFinal, source in
            Task { @MainActor in
                guard let self = self else { return }
                
                // Only handle final user transcripts
                if isFinal && source == "user" && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    // Add user message to chat UI
                    let userMessage = ChatMessage(
                        id: UUID().uuidString,
                        role: "user",
                        content: text,
                        createdAt: ISO8601DateFormatter().string(from: Date()),
                        meetingId: self.currentMeetingId
                    )
                    self.messages.append(userMessage)
                    
                    // Save to database (but DON'T call chat API - OpenAI Realtime handles response)
                    await self.saveMessageOnly(text, role: "user", meetingId: self.currentMeetingId)
                }
            }
        }
        
        // Handle AI responses from OpenAI Realtime
        // This is the ONLY AI response we use (no separate GPT-4 call)
        voiceService.onResponse = { [weak self] text in
            Task { @MainActor in
                guard let self = self else { return }
                
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                
                // Add AI response to chat UI
                let assistantMessage = ChatMessage(
                    id: UUID().uuidString,
                    role: "assistant",
                    content: text,
                    createdAt: ISO8601DateFormatter().string(from: Date()),
                    meetingId: self.currentMeetingId
                )
                self.messages.append(assistantMessage)
                
                // Save to database
                await self.saveMessageOnly(text, role: "assistant", meetingId: self.currentMeetingId)
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

