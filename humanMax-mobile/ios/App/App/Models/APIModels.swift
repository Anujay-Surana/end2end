import Foundation

/// Generic API error response from backend
struct APIErrorResponse: Codable {
    let error: String?
    let message: String?
    let details: String?
}

/// Meetings response
struct MeetingsResponse: Codable {
    let meetings: [Meeting]
}

/// Pre-generated brief data attached to meetings
struct MeetingBriefData: Codable {
    let oneLiner: String?
    let briefReady: Bool?
    let generatedAt: String?
    
    enum CodingKeys: String, CodingKey {
        case oneLiner = "one_liner"
        case briefReady = "brief_ready"
        case generatedAt = "generated_at"
    }
    
    /// Safely check if brief is ready
    var isReady: Bool {
        return briefReady ?? false
    }
}

/// Meeting model
struct Meeting: Codable, Identifiable {
    let id: String
    let summary: String
    let title: String?
    let description: String?
    let start: MeetingTime?
    let end: MeetingTime?
    let attendees: [Attendee]?
    let location: String?
    let htmlLink: String?
    let accountEmail: String?
    let brief: AnyCodable?
    let briefData: MeetingBriefData?
    
    // Ignore unknown fields like _classification from backend
    enum CodingKeys: String, CodingKey {
        case id, summary, title, description, start, end, attendees, location
        case htmlLink = "htmlLink"
        case accountEmail = "accountEmail"
        case brief
        case briefData = "_brief"
    }
    
    /// Get the one-liner summary if available
    var oneLiner: String? {
        return briefData?.oneLiner
    }
    
    /// Check if brief is ready
    var hasBriefReady: Bool {
        return briefData?.isReady ?? false
    }
}

/// Meeting time (can be dateTime or date)
/// Handles both string format (from backend) and dictionary format
struct MeetingTime: Codable {
    let dateTime: String?
    let date: String?
    let timeZone: String?
    
    init(dateTime: String?, date: String?, timeZone: String?) {
        self.dateTime = dateTime
        self.date = date
        self.timeZone = timeZone
    }
    
    init(from decoder: Decoder) throws {
        // Try to decode as dictionary first (expected format: {"dateTime": "...", "date": null, "timeZone": null})
        do {
            let keyedContainer = try decoder.container(keyedBy: CodingKeys.self)
            self.dateTime = try? keyedContainer.decodeIfPresent(String.self, forKey: .dateTime)
            self.date = try? keyedContainer.decodeIfPresent(String.self, forKey: .date)
            self.timeZone = try? keyedContainer.decodeIfPresent(String.self, forKey: .timeZone)
            return
        } catch {
            // If keyed container fails, try single value container (string format from backend)
        }
        
        // Fallback: try to decode as string (backend format: "2025-12-02T10:00:00-08:00")
        let container = try decoder.singleValueContainer()
        if let stringValue = try? container.decode(String.self) {
            // If it's a string, treat it as dateTime
            self.dateTime = stringValue
            self.date = nil
            self.timeZone = nil
        } else {
            // If neither format works, initialize with nil values
            self.dateTime = nil
            self.date = nil
            self.timeZone = nil
        }
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        
        // If only dateTime is set and it's a string format, encode as string
        if let dateTime = dateTime, date == nil && timeZone == nil {
            try container.encode(dateTime)
            return
        }
        
        // Otherwise encode as dictionary
        var dict: [String: String?] = [:]
        dict["dateTime"] = dateTime
        dict["date"] = date
        dict["timeZone"] = timeZone
        try container.encode(dict)
    }
    
    enum CodingKeys: String, CodingKey {
        case dateTime, date, timeZone
    }
}

/// Attendee model
struct Attendee: Codable {
    let email: String
    let displayName: String?
    let responseStatus: String?
    let organizer: Bool?
}

/// Day prep response
struct DayPrepResponse: Codable {
    let success: Bool
    let dayPrep: DayPrep?
}

/// Day prep model
struct DayPrep: Codable {
    let date: String
    let summary: String
    let meetings: [Meeting]
    let prep: [MeetingPrep]?
}

/// Meeting prep model
struct MeetingPrep: Codable {
    let meetingTitle: String
    let meetingDate: String
    let sections: [MeetingPrepSection]
    let summary: String?
}

/// Meeting prep section
struct MeetingPrepSection: Codable {
    let title: String
    let content: String
}

/// Chat messages response
struct ChatMessagesResponse: Codable {
    let success: Bool
    let messages: [ChatMessage]
}

/// Chat message send response (from POST /api/chat/messages)
struct ChatMessageSendResponse: Codable {
    let success: Bool
    let message: String?
    let userMessage: ChatMessage
    let assistantMessage: ChatMessage
}

/// Chat message model
struct ChatMessage: Codable, Identifiable {
    let id: String
    let role: String // "user", "assistant", "system"
    let content: String
    let created_at: String?
    let meeting_id: String?
    let function_results: [FunctionResult]?
    
    // Backend may include additional fields that we ignore
    enum CodingKeys: String, CodingKey {
        case id, role, content
        case created_at
        case meeting_id
        case function_results
    }
}

/// Function result from AI
struct FunctionResult: Codable {
    let function_name: String
    let result: AnyCodable?
    let error: String?
}

/// AnyCodable for handling dynamic JSON values
struct AnyCodable: Codable {
    let value: Any
    
    init(_ value: Any) {
        self.value = value
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        
        if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dictionary = try? container.decode([String: AnyCodable].self) {
            value = dictionary.mapValues { $0.value }
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "AnyCodable value cannot be decoded")
        }
    }
    
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        
        switch value {
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            let codableArray = array.map { AnyCodable($0) }
            try container.encode(codableArray)
        case let dictionary as [String: Any]:
            let codableDictionary = dictionary.mapValues { AnyCodable($0) }
            try container.encode(codableDictionary)
        default:
            throw EncodingError.invalidValue(value, EncodingError.Context(codingPath: container.codingPath, debugDescription: "AnyCodable value cannot be encoded"))
        }
    }
}

/// Device registration request
struct DeviceRegistrationRequest: Codable {
    let device_token: String
    let platform: String
    let timezone: String
    let device_info: DeviceInfo?
}

/// Device info
struct DeviceInfo: Codable {
    let platform: String?
    let appVersion: String?
}

/// Device registration response
struct DeviceRegistrationResponse: Codable {
    let success: Bool
    let device_id: String?
    let message: String?
}

