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
        
        isSending = true
        errorMessage = nil
        
        // Add user message optimistically
        let optimisticUserMessage = ChatMessage(
            id: UUID().uuidString,
            role: "user",
            content: text,
            created_at: ISO8601DateFormatter().string(from: Date()),
            meeting_id: meetingId,
            function_results: nil
        )
        messages.append(optimisticUserMessage)
        
        do {
            let response: ChatMessageSendResponse
            
            if let meetingId = meetingId {
                // Use meeting-specific endpoint (auto-injects brief context)
                response = try await apiClient.sendMeetingChat(meetingId: meetingId, message: text)
            } else {
                // Use general chat endpoint
                response = try await apiClient.sendChatMessage(message: text, meetingId: nil)
            }
            
            // Replace optimistic message with actual user message from backend
            if let index = messages.firstIndex(where: { $0.id == optimisticUserMessage.id }) {
                messages[index] = response.userMessage
            } else {
                messages.append(response.userMessage)
            }
            
            // Add assistant message
            messages.append(response.assistantMessage)
        } catch {
            errorMessage = error.localizedDescription
            // Remove optimistic message on error
            messages.removeAll { $0.id == optimisticUserMessage.id }
        }
        
        isSending = false
    }
    
    func deleteMessage(_ messageId: String) async {
        do {
            _ = try await apiClient.deleteChatMessage(messageId: messageId)
            await loadMessages()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
    
    func startVoiceRecording() async {
        do {
            try await voiceService.start()
            isRecording = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }
    
    func stopVoiceRecording() async {
        await voiceService.stop()
        isRecording = false
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
        voiceService.onTranscript = { [weak self] text, isFinal, source in
            Task { @MainActor in
                // Handle transcript updates - only send user's final transcript as message
                if isFinal && source == "user" {
                    await self?.sendMessage(text)
                }
            }
        }
        
        voiceService.onResponse = { [weak self] text in
            Task { @MainActor in
                // Handle AI response
                await self?.loadMessages()
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

