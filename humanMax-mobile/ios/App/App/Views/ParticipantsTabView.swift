import SwiftUI

/// Tab view showing attendee research for a meeting
struct ParticipantsTabView: View {
    let meeting: Meeting
    
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let attendees = attendeesWithResearch, !attendees.isEmpty {
                    ForEach(attendees, id: \.email) { research in
                        AttendeeResearchCardView(research: research)
                    }
                } else if let basicAttendees = meeting.attendees, !basicAttendees.isEmpty {
                    // Show basic attendee list without research
                    ForEach(basicAttendees, id: \.email) { attendee in
                        BasicAttendeeCard(attendee: attendee)
                    }
                } else {
                    EmptyParticipantsView()
                }
            }
            .padding()
        }
    }
    
    // MARK: - Computed Properties
    
    private var attendeesWithResearch: [AttendeeResearch]? {
        return meeting.fullBrief?.attendees
    }
}

// MARK: - Attendee Card with Research

struct AttendeeResearchCardView: View {
    let research: AttendeeResearch
    @State private var isExpanded = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header - Always visible
            Button(action: { withAnimation(.spring(response: 0.3)) { isExpanded.toggle() } }) {
                HStack(spacing: 12) {
                    // Avatar
                    Circle()
                        .fill(avatarColor)
                        .frame(width: 48, height: 48)
                        .overlay(
                            Text(initials)
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundColor(.white)
                        )
                    
                    VStack(alignment: .leading, spacing: 2) {
                        Text(displayName)
                            .font(.headline)
                            .foregroundColor(.primary)
                        
                        if let title = research.title, !title.isEmpty {
                            Text(title)
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                        }
                        
                        if let company = research.company, !company.isEmpty {
                            Text(company)
                                .font(.caption)
                                .foregroundColor(.secondary.opacity(0.8))
                        }
                    }
                    
                    Spacer()
                    
                    // Expand indicator
                    if hasExpandableContent {
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundColor(.secondary)
                    }
                }
                .padding()
            }
            .buttonStyle(PlainButtonStyle())
            
            // Expanded content
            if isExpanded && hasExpandableContent {
                VStack(alignment: .leading, spacing: 16) {
                    Divider()
                        .padding(.horizontal)
                    
                    // Key Facts
                    if let keyFacts = research.keyFacts, !keyFacts.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("Key Facts", systemImage: "lightbulb")
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundColor(.secondary)
                            
                            ForEach(keyFacts, id: \.self) { fact in
                                HStack(alignment: .top, spacing: 8) {
                                    Circle()
                                        .fill(Color.green)
                                        .frame(width: 6, height: 6)
                                        .padding(.top, 6)
                                    
                                    Text(fact)
                                        .font(.subheadline)
                                        .foregroundColor(.primary)
                                }
                            }
                        }
                        .padding(.horizontal)
                    }
                    
                    // Data source indicator
                    if let source = research.researchSource {
                        HStack {
                            Image(systemName: source.lowercased().contains("web") ? "globe" : "envelope")
                                .font(.caption2)
                            Text("Source: \(source)")
                                .font(.caption2)
                        }
                        .foregroundColor(.secondary.opacity(0.7))
                        .padding(.horizontal)
                    }
                }
                .padding(.bottom)
            }
        }
        .background(Color(.secondarySystemBackground))
        .cornerRadius(12)
    }
    
    // MARK: - Computed Properties
    
    private var displayName: String {
        research.name ?? research.email?.components(separatedBy: "@").first ?? research.email ?? "Unknown"
    }
    
    private var initials: String {
        let name = displayName
        let components = name.components(separatedBy: " ")
        if components.count >= 2 {
            return "\(components[0].prefix(1))\(components[1].prefix(1))".uppercased()
        }
        return String(name.prefix(2)).uppercased()
    }
    
    private var avatarColor: Color {
        // Generate consistent color from email
        let hash = (research.email ?? "unknown").hashValue
        let hue = Double(abs(hash) % 360) / 360.0
        return Color(hue: hue, saturation: 0.5, brightness: 0.7)
    }
    
    private var hasExpandableContent: Bool {
        return research.keyFacts?.isEmpty == false
    }
}

// MARK: - Basic Attendee Card (without research)

struct BasicAttendeeCard: View {
    let attendee: Attendee
    
    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(avatarColor)
                .frame(width: 44, height: 44)
                .overlay(
                    Text(initials)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.white)
                )
            
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(displayName)
                        .font(.subheadline)
                        .fontWeight(.medium)
                    
                    if attendee.organizer == true {
                        Text("Organizer")
                            .font(.caption2)
                            .foregroundColor(.blue)
                    }
                }
                
                Text(attendee.email)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            
            Spacer()
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .cornerRadius(12)
    }
    
    private var displayName: String {
        attendee.displayName ?? attendee.email.components(separatedBy: "@").first ?? attendee.email
    }
    
    private var initials: String {
        let name = displayName
        let components = name.components(separatedBy: " ")
        if components.count >= 2 {
            return "\(components[0].prefix(1))\(components[1].prefix(1))".uppercased()
        }
        return String(name.prefix(2)).uppercased()
    }
    
    private var avatarColor: Color {
        let hash = attendee.email.hashValue
        let hue = Double(abs(hash) % 360) / 360.0
        return Color(hue: hue, saturation: 0.5, brightness: 0.7)
    }
}

// MARK: - Empty State

struct EmptyParticipantsView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.2.slash")
                .font(.system(size: 48))
                .foregroundColor(.secondary.opacity(0.5))
            
            Text("No Participants")
                .font(.headline)
                .foregroundColor(.secondary)
            
            Text("This meeting doesn't have any attendees listed.")
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
        attendees: [
            Attendee(email: "john@example.com", displayName: "John Smith", responseStatus: nil, organizer: true),
            Attendee(email: "jane@example.com", displayName: "Jane Doe", responseStatus: nil, organizer: false)
        ],
        location: nil,
        htmlLink: nil,
        accountEmail: nil,
        brief: nil,
        briefData: nil
    )
    
    ParticipantsTabView(meeting: sampleMeeting)
}

