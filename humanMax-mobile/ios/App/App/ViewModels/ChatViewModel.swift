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
    
    func loadMessages(meetingId: String? = nil) async {
        isLoading = true
        errorMessage = nil
        
        do {
            let response = try await apiClient.getChatMessages(meetingId: meetingId)
            messages = response.messages
        } catch {
            errorMessage = error.localizedDescription
        }
        
        isLoading = false
    }
    
    func sendMessage(_ text: String, meetingId: String? = nil) async {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        
        isSending = true
        errorMessage = nil
        
        // Add user message optimistically
        let userMessage = ChatMessage(
            id: UUID().uuidString,
            role: "user",
            content: text,
            created_at: ISO8601DateFormatter().string(from: Date()),
            meeting_id: meetingId,
            function_results: nil
        )
        messages.append(userMessage)
        
        do {
            _ = try await apiClient.sendChatMessage(message: text, meetingId: meetingId)
            // Reload messages to get assistant response
            await loadMessages(meetingId: meetingId)
        } catch {
            errorMessage = error.localizedDescription
            // Remove optimistic message on error
            messages.removeAll { $0.id == userMessage.id }
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
        voiceService.onTranscript = { [weak self] text, isFinal in
            Task { @MainActor in
                // Handle transcript updates
                if isFinal {
                    // Send final transcript as message
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

