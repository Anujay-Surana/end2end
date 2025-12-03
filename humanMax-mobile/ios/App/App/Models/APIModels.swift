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
    let briefData: AnyCodable?
    
    enum CodingKeys: String, CodingKey {
        case oneLiner = "one_liner"
        case briefReady = "brief_ready"
        case generatedAt = "generated_at"
        case briefData = "brief_data"
    }
    
    /// Custom decoder with debug logging
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        
        // Debug: print all keys present in the container
        print("🔍 MeetingBriefData decoding - available keys: \(container.allKeys.map { $0.stringValue })")
        
        // Decode each field with logging
        self.oneLiner = try container.decodeIfPresent(String.self, forKey: .oneLiner)
        print("   one_liner decoded: \(oneLiner ?? "nil")")
        
        self.briefReady = try container.decodeIfPresent(Bool.self, forKey: .briefReady)
        print("   brief_ready decoded: \(briefReady?.description ?? "nil")")
        
        self.generatedAt = try container.decodeIfPresent(String.self, forKey: .generatedAt)
        print("   generated_at decoded: \(generatedAt ?? "nil")")
        
        self.briefData = try container.decodeIfPresent(AnyCodable.self, forKey: .briefData)
        print("   brief_data decoded: \(briefData != nil ? "present" : "nil")")
    }
    
    /// Safely check if brief is ready
    var isReady: Bool {
        return briefReady ?? false
    }
    
    /// Get the full brief as FullBriefData (parsed from AnyCodable)
    var fullBrief: FullBriefData? {
        guard let briefData = briefData?.value as? [String: Any] else { return nil }
        do {
            let jsonData = try JSONSerialization.data(withJSONObject: briefData)
            return try JSONDecoder().decode(FullBriefData.self, from: jsonData)
        } catch {
            print("Error parsing full brief: \(error)")
            return nil
        }
    }
}

/// Full brief data containing attendee research, document analysis, etc.
struct FullBriefData: Codable {
    let summary: String?
    let purpose: String?
    let agenda: [String]?
    let emailAnalysis: String?
    let documentAnalysis: String?
    let recommendations: [String]?
    let actionItems: [String]?
    let attendees: [AttendeeResearch]?
    let stats: BriefStats?
    
    enum CodingKeys: String, CodingKey {
        case summary, purpose, agenda
        case emailAnalysis = "emailAnalysis"
        case documentAnalysis = "documentAnalysis"
        case recommendations
        case actionItems = "actionItems"
        case attendees
        case stats
    }
}

/// Attendee with research data
struct AttendeeResearch: Codable {
    let name: String?
    let email: String?
    let title: String?
    let company: String?
    let keyFacts: [String]?
    let source: String?
    
    enum CodingKeys: String, CodingKey {
        case name, email, title, company
        case keyFacts = "keyFacts"
        case source
    }
}

/// Brief statistics
struct BriefStats: Codable {
    let emailCount: Int?
    let fileCount: Int?
    let attendeeCount: Int?
    
    enum CodingKeys: String, CodingKey {
        case emailCount = "emailCount"
        case fileCount = "fileCount"
        case attendeeCount = "attendeeCount"
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
    
    /// Get the full brief data
    var fullBrief: FullBriefData? {
        return briefData?.fullBrief
    }
    
    /// Get attendees with research data
    var attendeesWithResearch: [AttendeeResearch]? {
        return fullBrief?.attendees
    }
    
    /// Get brief summary
    var briefSummary: String? {
        return fullBrief?.summary
    }
    
    /// Get email analysis
    var emailAnalysis: String? {
        return fullBrief?.emailAnalysis
    }
    
    /// Get document analysis
    var documentAnalysis: String? {
        return fullBrief?.documentAnalysis
    }
    
    /// Get recommendations
    var recommendations: [String]? {
        return fullBrief?.recommendations
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
    let userMessage: ChatMessage?
    let assistantMessage: ChatMessage?
    let meetingId: String?
    
    enum CodingKeys: String, CodingKey {
        case success, message
        case userMessage = "user_message"
        case assistantMessage = "assistant_message"
        case meetingId = "meeting_id"
    }
}

/// Metadata for chat messages
struct ChatMessageMetadata: Codable {
    let meetingId: String?
    let toolCalls: AnyCodable?
    let rawRole: String?
    let toolCallId: String?
    let functionName: String?
    let isToolResult: Bool?
    
    enum CodingKeys: String, CodingKey {
        case meetingId = "meeting_id"
        case toolCalls = "tool_calls"
        case rawRole = "raw_role"
        case toolCallId = "tool_call_id"
        case functionName = "function_name"
        case isToolResult = "is_tool_result"
    }
    
    init(meetingId: String?, toolCalls: AnyCodable?, rawRole: String?, toolCallId: String?, functionName: String?, isToolResult: Bool?) {
        self.meetingId = meetingId
        self.toolCalls = toolCalls
        self.rawRole = rawRole
        self.toolCallId = toolCallId
        self.functionName = functionName
        self.isToolResult = isToolResult
    }
}

/// Chat message model
struct ChatMessage: Codable, Identifiable {
    let id: String
    let role: String // "user", "assistant", "system"
    let content: String
    let createdAt: String?
    let userId: String?
    let metadata: ChatMessageMetadata?
    let functionResults: [FunctionResult]?
    
    // Backend may include additional fields that we ignore
    enum CodingKeys: String, CodingKey {
        case id, role, content
        case createdAt = "created_at"
        case userId = "user_id"
        case metadata
        case functionResults = "function_results"
    }
    
    /// Get meeting_id from metadata
    var meetingId: String? {
        return metadata?.meetingId
    }
    
    /// Convenience initializer for creating optimistic messages
    init(id: String, role: String, content: String, createdAt: String? = nil, userId: String? = nil, meetingId: String? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.createdAt = createdAt
        self.userId = userId
        self.functionResults = nil
        
        // Create metadata with meeting_id if provided
        if let meetingId = meetingId {
            self.metadata = ChatMessageMetadata(
                meetingId: meetingId,
                toolCalls: nil,
                rawRole: nil,
                toolCallId: nil,
                functionName: nil,
                isToolResult: nil
            )
        } else {
            self.metadata = nil
        }
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

