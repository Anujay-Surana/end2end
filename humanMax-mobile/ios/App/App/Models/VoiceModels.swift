import Foundation

/// Transcript message model for voice conversations
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

