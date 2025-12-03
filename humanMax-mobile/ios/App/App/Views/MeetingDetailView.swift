import SwiftUI

// Renamed to avoid conflict with existing MeetingDetailView in CalendarView.swift
struct HomeMeetingDetailView: View {
    let meeting: Meeting
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var meetingsViewModel: MeetingsViewModel
    @State private var showPrepChat = false
    
    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // Title
                    Text(meeting.summary)
                        .font(.title)
                        .fontWeight(.bold)
                        .foregroundColor(.primary)
                    
                    // Time Section
                    DetailRow(
                        icon: "clock",
                        label: "Time",
                        value: formattedDateTime
                    )
                    
                    // Location Section
                    if let location = meeting.location, !location.isEmpty {
                        DetailRow(
                            icon: "location",
                            label: "Location",
                            value: location
                        )
                    }
                    
                    // Attendees Section
                    if let attendees = meeting.attendees, !attendees.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 8) {
                                Image(systemName: "person.2")
                                    .foregroundColor(.secondary)
                                Text("Attendees (\(attendees.count))")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                    .textCase(.uppercase)
                                    .tracking(0.5)
                            }
                            
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(attendees.prefix(6), id: \.email) { attendee in
                                    HStack {
                                        Text(attendee.displayName ?? attendee.email)
                                            .font(.subheadline)
                                        if attendee.organizer == true {
                                            Text("(organizer)")
                                                .font(.caption)
                                                .foregroundColor(.secondary)
                                        }
                                    }
                                    .padding(.vertical, 4)
                                    
                                    if attendee.email != attendees.prefix(6).last?.email {
                                        Divider()
                                    }
                                }
                                
                                if attendees.count > 6 {
                                    Text("+\(attendees.count - 6) more")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                        .italic()
                                        .padding(.top, 4)
                                }
                            }
                        }
                    }
                    
                    // Summary Section
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Summary")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .textCase(.uppercase)
                            .tracking(0.5)
                        
                        Text(extendedSummary)
                            .font(.body)
                            .foregroundColor(.secondary)
                            .lineSpacing(4)
                    }
                    
                    // Key Insights Section
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Key Insights")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .textCase(.uppercase)
                            .tracking(0.5)
                        
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(keyInsights, id: \.self) { insight in
                                HStack(alignment: .top, spacing: 8) {
                                    Text("•")
                                        .fontWeight(.bold)
                                    Text(insight)
                                        .font(.subheadline)
                                        .foregroundColor(.secondary)
                                }
                            }
                        }
                    }
                    
                    Spacer(minLength: 80)
                }
                .padding()
            }
            .navigationTitle("Meeting Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { dismiss() }) {
                        Image(systemName: "chevron.left")
                            .foregroundColor(.primary)
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                // Prep Button
                Button(action: {
                    showPrepChat = true
                }) {
                    Text("Prep")
                        .font(.headline)
                        .fontWeight(.semibold)
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.black)
                        .cornerRadius(12)
                }
                .padding()
                .background(Color(.systemBackground))
            }
        }
        .fullScreenCover(isPresented: $showPrepChat) {
            PrepChatView(meeting: meeting)
        }
    }
    
    // MARK: - Computed Properties
    
    private var formattedDateTime: String {
        var result = ""
        
        guard let start = meeting.start, let dateTime = start.dateTime else {
            return "Time not specified"
        }
        
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        
        if let date = formatter.date(from: dateTime) ?? ISO8601DateFormatter().date(from: dateTime) {
            let dateFormatter = DateFormatter()
            dateFormatter.dateFormat = "EEEE, MMMM d"
            result = dateFormatter.string(from: date)
            
            let timeFormatter = DateFormatter()
            timeFormatter.timeStyle = .short
            result += " at " + timeFormatter.string(from: date)
            
            // Add end time if available
            if let end = meeting.end, let endDateTime = end.dateTime,
               let endDate = formatter.date(from: endDateTime) ?? ISO8601DateFormatter().date(from: endDateTime) {
                result += " - " + timeFormatter.string(from: endDate)
            }
        }
        
        return result
    }
    
    private var extendedSummary: String {
        // First try the pre-generated one-liner summary
        if let oneLiner = meeting.oneLiner, !oneLiner.isEmpty {
            return oneLiner
        }
        
        // Fall back to description
        if let description = meeting.description, !description.isEmpty {
            let trimmed = description.prefix(200)
            return String(trimmed) + (description.count > 200 ? "..." : "")
        }
        
        return "No meeting description available. Click \"Prep\" to generate a meeting brief with AI-powered insights."
    }
    
    private var keyInsights: [String] {
        // If brief is ready, show actual insights from brief data
        if meeting.hasBriefReady, let fullBrief = meeting.fullBrief {
            var insights: [String] = []
            
            // Add recommendations if available
            if let recommendations = fullBrief.recommendations, !recommendations.isEmpty {
                insights.append(contentsOf: recommendations.prefix(3))
            }
            
            // Add attendee insights
            if let attendees = fullBrief.attendees, !attendees.isEmpty {
                let attendeeWithFacts = attendees.first { ($0.keyFacts?.count ?? 0) > 0 }
                if let attendee = attendeeWithFacts, let facts = attendee.keyFacts, let firstFact = facts.first {
                    insights.append("About \(attendee.name ?? "attendee"): \(firstFact)")
                }
            }
            
            // Add stats-based insights
            if let stats = fullBrief.stats {
                if let emailCount = stats.emailCount, emailCount > 0 {
                    insights.append("Analyzed \(emailCount) relevant emails")
                }
                if let fileCount = stats.fileCount, fileCount > 0 {
                    insights.append("Reviewed \(fileCount) related documents")
                }
            }
            
            // Return insights or default message
            if !insights.isEmpty {
                return Array(insights.prefix(4))
            }
            
            return [
                "Brief is ready - tap \"Prep\" to chat about this meeting",
                "AI has analyzed attendees and context",
                "Ask questions to prepare effectively"
            ]
        }
        
        // Placeholder insights when brief isn't ready
        return [
            "Tap \"Prep\" to generate a meeting brief",
            "AI will analyze attendees and context",
            "Get personalized recommendations"
        ]
    }
}

// MARK: - Detail Row Component

struct DetailRow: View {
    let icon: String
    let label: String
    let value: String
    
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundColor(.secondary)
                .frame(width: 24)
            
            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .textCase(.uppercase)
                    .tracking(0.5)
                
                Text(value)
                    .font(.subheadline)
                    .foregroundColor(.primary)
            }
        }
    }
}

#Preview {
    let sampleMeeting = Meeting(
        id: "1",
        summary: "Q4 Planning Session",
        title: nil,
        description: "Discuss Q4 goals and roadmap",
        start: MeetingTime(dateTime: ISO8601DateFormatter().string(from: Date()), date: nil, timeZone: nil),
        end: MeetingTime(dateTime: ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)), date: nil, timeZone: nil),
        attendees: [
            Attendee(email: "john@example.com", displayName: "John Smith", responseStatus: nil, organizer: true)
        ],
        location: "Conference Room A",
        htmlLink: nil,
        accountEmail: nil,
        brief: nil,
        briefData: nil
    )
    
    HomeMeetingDetailView(meeting: sampleMeeting)
        .environmentObject(MeetingsViewModel())
}
