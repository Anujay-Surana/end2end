import SwiftUI

/// Tab view showing chronological timeline of events related to a meeting
struct TimelineTabView: View {
    let meeting: Meeting
    
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let timeline = timelineEvents, !timeline.isEmpty {
                    ForEach(Array(timeline.enumerated()), id: \.offset) { index, event in
                        TimelineEventRow(
                            event: event,
                            isFirst: index == 0,
                            isLast: index == timeline.count - 1
                        )
                    }
                } else {
                    EmptyTimelineView()
                }
            }
            .padding()
        }
    }
    
    // MARK: - Computed Properties
    
    private var timelineEvents: [TimelineEvent]? {
        return meeting.fullBrief?.timeline
    }
}

// MARK: - Timeline Event Row

struct TimelineEventRow: View {
    let event: TimelineEvent
    let isFirst: Bool
    let isLast: Bool
    
    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            // Timeline indicator
            VStack(spacing: 0) {
                // Top line
                Rectangle()
                    .fill(isFirst ? Color.clear : Color.secondary.opacity(0.3))
                    .frame(width: 2, height: 12)
                
                // Event dot
                Circle()
                    .fill(eventColor)
                    .frame(width: 12, height: 12)
                    .overlay(
                        Circle()
                            .stroke(eventColor.opacity(0.3), lineWidth: 4)
                    )
                
                // Bottom line
                Rectangle()
                    .fill(isLast ? Color.clear : Color.secondary.opacity(0.3))
                    .frame(width: 2)
                    .frame(maxHeight: .infinity)
            }
            .frame(width: 20)
            
            // Event content
            VStack(alignment: .leading, spacing: 8) {
                // Event type badge and date
                HStack {
                    Label(eventTypeLabel, systemImage: eventIcon)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundColor(eventColor)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(eventColor.opacity(0.1))
                        .cornerRadius(6)
                    
                    Spacer()
                    
                    if let dateStr = formattedDate {
                        Text(dateStr)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                
                // Event title/subject
                if let subject = event.subject ?? event.name {
                    Text(subject)
                        .font(.subheadline)
                        .fontWeight(.medium)
                        .foregroundColor(.primary)
                        .lineLimit(2)
                }
                
                // Participants
                if let participants = event.participants, !participants.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "person.2")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        
                        Text(participants.prefix(3).joined(separator: ", "))
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                        
                        if participants.count > 3 {
                            Text("+\(participants.count - 3)")
                                .font(.caption)
                                .foregroundColor(.secondary.opacity(0.7))
                        }
                    }
                }
                
                // Snippet/action
                if let snippet = event.snippet ?? event.action {
                    Text(snippet)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(3)
                        .padding(.top, 2)
                }
            }
            .padding(.vertical, 12)
            .padding(.trailing, 8)
        }
        .padding(.bottom, 8)
    }
    
    // MARK: - Computed Properties
    
    private var eventColor: Color {
        switch event.type?.lowercased() {
        case "email":
            return .blue
        case "meeting", "calendar":
            return .green
        case "document", "file":
            return .orange
        case "drive":
            return .purple
        default:
            return .gray
        }
    }
    
    private var eventIcon: String {
        switch event.type?.lowercased() {
        case "email":
            return "envelope"
        case "meeting", "calendar":
            return "calendar"
        case "document", "file":
            return "doc.text"
        case "drive":
            return "folder"
        default:
            return "circle"
        }
    }
    
    private var eventTypeLabel: String {
        switch event.type?.lowercased() {
        case "email":
            return "Email"
        case "meeting", "calendar":
            return "Meeting"
        case "document", "file":
            return "Document"
        case "drive":
            return "Drive"
        default:
            return event.type ?? "Event"
        }
    }
    
    private var formattedDate: String? {
        // Try timestamp first
        if let timestamp = event.timestamp {
            let date = Date(timeIntervalSince1970: timestamp)
            return formatDate(date)
        }
        
        // Try date string
        if let dateStr = event.date {
            // Try ISO8601 format
            let isoFormatter = ISO8601DateFormatter()
            isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            
            if let date = isoFormatter.date(from: dateStr) ?? ISO8601DateFormatter().date(from: dateStr) {
                return formatDate(date)
            }
            
            // Return as-is if can't parse
            return dateStr
        }
        
        return nil
    }
    
    private func formatDate(_ date: Date) -> String {
        let calendar = Calendar.current
        let now = Date()
        
        if calendar.isDateInToday(date) {
            let formatter = DateFormatter()
            formatter.timeStyle = .short
            return "Today, " + formatter.string(from: date)
        } else if calendar.isDateInYesterday(date) {
            let formatter = DateFormatter()
            formatter.timeStyle = .short
            return "Yesterday, " + formatter.string(from: date)
        } else {
            let daysDiff = calendar.dateComponents([.day], from: date, to: now).day ?? 0
            if daysDiff < 7 {
                let formatter = DateFormatter()
                formatter.dateFormat = "EEEE, h:mm a"
                return formatter.string(from: date)
            } else {
                let formatter = DateFormatter()
                formatter.dateFormat = "MMM d, h:mm a"
                return formatter.string(from: date)
            }
        }
    }
}

// MARK: - Empty State

struct EmptyTimelineView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 48))
                .foregroundColor(.secondary.opacity(0.5))
            
            Text("No Timeline Available")
                .font(.headline)
                .foregroundColor(.secondary)
            
            Text("Timeline events will appear here after the meeting brief is generated.")
                .font(.subheadline)
                .foregroundColor(.secondary.opacity(0.8))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 200)
        .padding()
    }
}

#Preview {
    let sampleMeeting = Meeting(
        id: "1",
        summary: "Q4 Planning",
        title: nil,
        description: nil,
        start: nil,
        end: nil,
        attendees: nil,
        location: nil,
        htmlLink: nil,
        accountEmail: nil,
        brief: nil,
        briefData: nil
    )
    
    TimelineTabView(meeting: sampleMeeting)
}

