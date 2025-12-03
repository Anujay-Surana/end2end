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

/// Meeting model
struct Meeting: Codable, Identifiable {
    let id: String
    let summary: String
    let title: String?
    let description: String?
    let start: MeetingTime
    let end: MeetingTime
    let attendees: [Attendee]?
    let location: String?
    let htmlLink: String?
    let accountEmail: String?
    let brief: AnyCodable?
}

/// Meeting time (can be dateTime or date)
struct MeetingTime: Codable {
    let dateTime: String?
    let date: String?
    let timeZone: String?
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

/// Chat message model
struct ChatMessage: Codable, Identifiable {
    let id: String
    let role: String // "user", "assistant", "system"
    let content: String
    let created_at: String?
    let meeting_id: String?
    let function_results: [FunctionResult]?
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

