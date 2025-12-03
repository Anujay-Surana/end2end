import SwiftUI

/// Tab selection for meeting detail view
enum MeetingDetailTab: String, CaseIterable {
    case overview = "Overview"
    case participants = "Participants"
    case timeline = "Timeline"
    
    var icon: String {
        switch self {
        case .overview: return "doc.text"
        case .participants: return "person.2"
        case .timeline: return "clock"
        }
    }
}

// Renamed to avoid conflict with existing MeetingDetailView in CalendarView.swift
struct HomeMeetingDetailView: View {
    let meeting: Meeting
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var meetingsViewModel: MeetingsViewModel
    @State private var showPrepChat = false
    @State private var selectedTab: MeetingDetailTab = .overview
    
    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                // Custom Tab Bar
                HStack(spacing: 0) {
                    ForEach(MeetingDetailTab.allCases, id: \.self) { tab in
                        TabButton(
                            tab: tab,
                            isSelected: selectedTab == tab,
                            badgeCount: badgeCount(for: tab)
                        ) {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                selectedTab = tab
                            }
                        }
                    }
                }
                .padding(.horizontal)
                .padding(.top, 8)
                
                Divider()
                    .padding(.top, 8)
                
                // Tab Content
                TabView(selection: $selectedTab) {
                    OverviewTabContent(meeting: meeting)
                        .tag(MeetingDetailTab.overview)
                    
                    ParticipantsTabView(meeting: meeting)
                        .tag(MeetingDetailTab.participants)
                    
                    TimelineTabView(meeting: meeting)
                        .tag(MeetingDetailTab.timeline)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
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
    
    // MARK: - Badge Counts
    
    private func badgeCount(for tab: MeetingDetailTab) -> Int? {
        switch tab {
        case .overview:
            return nil
        case .participants:
            return meeting.attendees?.count
        case .timeline:
            return meeting.fullBrief?.timeline?.count
        }
    }
    
}

// MARK: - Tab Button Component

struct TabButton: View {
    let tab: MeetingDetailTab
    let isSelected: Bool
    let badgeCount: Int?
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                HStack(spacing: 4) {
                    Image(systemName: tab.icon)
                        .font(.system(size: 14))
                    
                    Text(tab.rawValue)
                        .font(.subheadline)
                        .fontWeight(isSelected ? .semibold : .regular)
                    
                    if let count = badgeCount, count > 0 {
                        Text("\(count)")
                            .font(.caption2)
                            .fontWeight(.medium)
                            .foregroundColor(isSelected ? .white : .secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(isSelected ? Color.black : Color.secondary.opacity(0.2))
                            .cornerRadius(10)
                    }
                }
                .foregroundColor(isSelected ? .primary : .secondary)
                
                // Selection indicator
                Rectangle()
                    .fill(isSelected ? Color.black : Color.clear)
                    .frame(height: 2)
            }
        }
        .buttonStyle(PlainButtonStyle())
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Overview Tab Content

struct OverviewTabContent: View {
    let meeting: Meeting
    
    var body: some View {
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
                
                // Quick Attendees Preview
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
                        
                        // Avatar stack
                        HStack(spacing: -8) {
                            ForEach(attendees.prefix(5), id: \.email) { attendee in
                                Circle()
                                    .fill(avatarColor(for: attendee.email))
                                    .frame(width: 32, height: 32)
                                    .overlay(
                                        Text(initials(for: attendee))
                                            .font(.system(size: 12, weight: .medium))
                                            .foregroundColor(.white)
                                    )
                                    .overlay(
                                        Circle()
                                            .stroke(Color(.systemBackground), lineWidth: 2)
                                    )
                            }
                            
                            if attendees.count > 5 {
                                Circle()
                                    .fill(Color.secondary.opacity(0.3))
                                    .frame(width: 32, height: 32)
                                    .overlay(
                                        Text("+\(attendees.count - 5)")
                                            .font(.system(size: 10, weight: .medium))
                                            .foregroundColor(.secondary)
                                    )
                                    .overlay(
                                        Circle()
                                            .stroke(Color(.systemBackground), lineWidth: 2)
                                    )
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
    }
    
    // MARK: - Helper Methods
    
    private func avatarColor(for email: String) -> Color {
        let hash = email.hashValue
        let hue = Double(abs(hash) % 360) / 360.0
        return Color(hue: hue, saturation: 0.5, brightness: 0.7)
    }
    
    private func initials(for attendee: Attendee) -> String {
        let name = attendee.displayName ?? attendee.email.components(separatedBy: "@").first ?? ""
        let components = name.components(separatedBy: " ")
        if components.count >= 2 {
            return "\(components[0].prefix(1))\(components[1].prefix(1))".uppercased()
        }
        return String(name.prefix(2)).uppercased()
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
