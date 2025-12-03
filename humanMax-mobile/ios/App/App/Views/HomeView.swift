import SwiftUI

struct HomeView: View {
    @EnvironmentObject var meetingsViewModel: MeetingsViewModel
    @State private var selectedMeeting: Meeting?
    
    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // Date Header
                    VStack(alignment: .leading, spacing: 4) {
                        Text(formattedDate)
                            .font(.system(size: 28, weight: .bold))
                            .foregroundColor(.primary)
                        
                        Text("Today's Schedule")
                            .font(.caption)
                            .fontWeight(.medium)
                            .foregroundColor(.secondary)
                            .textCase(.uppercase)
                            .tracking(1)
                    }
                    .padding(.horizontal)
                    .padding(.top, 8)
                    
                    // Meetings List
                    if meetingsViewModel.isLoading && meetingsViewModel.meetings.isEmpty {
                        loadingView
                    } else if meetingsViewModel.meetings.isEmpty {
                        emptyStateView
                    } else {
                        meetingsListView
                    }
                }
                .padding(.vertical)
            }
            .navigationBarHidden(true)
            .refreshable {
                await meetingsViewModel.loadMeetings(for: Date())
            }
        }
        .task {
            await meetingsViewModel.loadMeetings(for: Date())
        }
        .sheet(item: $selectedMeeting) { meeting in
            HomeMeetingDetailView(meeting: meeting)
                .environmentObject(meetingsViewModel)
        }
    }
    
    // MARK: - Date Formatting
    
    private var formattedDate: String {
        let now = Date()
        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE"
        let weekday = formatter.string(from: now)
        
        let calendar = Calendar.current
        let day = calendar.component(.day, from: now)
        let suffix = daySuffix(for: day)
        
        formatter.dateFormat = "MMMM yyyy"
        let monthYear = formatter.string(from: now)
        
        return "\(weekday), \(day)\(suffix) \(monthYear)"
    }
    
    private func daySuffix(for day: Int) -> String {
        if day >= 11 && day <= 13 {
            return "th"
        }
        switch day % 10 {
        case 1: return "st"
        case 2: return "nd"
        case 3: return "rd"
        default: return "th"
        }
    }
    
    // MARK: - Subviews
    
    private var loadingView: some View {
        VStack(spacing: 16) {
            ProgressView()
            Text("Loading your meetings...")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }
    
    private var emptyStateView: some View {
        VStack(spacing: 16) {
            Image(systemName: "calendar")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            
            Text("No meetings today")
                .font(.headline)
            
            Text("Enjoy your free day!")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }
    
    private var meetingsListView: some View {
        VStack(spacing: 12) {
            ForEach(meetingsViewModel.meetings) { meeting in
                HomeMeetingCard(meeting: meeting)
                    .onTapGesture {
                        selectedMeeting = meeting
                    }
            }
        }
        .padding(.horizontal)
    }
}

// MARK: - Meeting Card

struct HomeMeetingCard: View {
    let meeting: Meeting
    
    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            // Time
            Text(formattedTime)
                .font(.subheadline)
                .fontWeight(.semibold)
                .foregroundColor(.primary)
                .frame(width: 64, alignment: .leading)
            
            // Content
            VStack(alignment: .leading, spacing: 6) {
                Text(meeting.summary)
                    .font(.body)
                    .fontWeight(.semibold)
                    .foregroundColor(.primary)
                    .lineLimit(2)
                
                if let attendees = meeting.attendees, !attendees.isEmpty {
                    Text(formattedAttendees(attendees))
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                
                Text(meetingSummary)
                    .font(.caption)
                    .foregroundColor(.gray)
                    .lineLimit(2)
            }
            
            Spacer()
            
            // Arrow
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundColor(.gray)
        }
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.gray.opacity(0.2), lineWidth: 1)
        )
    }
    
    private var formattedTime: String {
        guard let start = meeting.start, let dateTime = start.dateTime else {
            return ""
        }
        
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        
        if let date = formatter.date(from: dateTime) ?? ISO8601DateFormatter().date(from: dateTime) {
            let timeFormatter = DateFormatter()
            timeFormatter.timeStyle = .short
            return timeFormatter.string(from: date)
        }
        return ""
    }
    
    private func formattedAttendees(_ attendees: [Attendee]) -> String {
        let names = attendees.prefix(3).compactMap { attendee -> String? in
            if let name = attendee.displayName, !name.isEmpty {
                return name
            }
            return attendee.email.components(separatedBy: "@").first
        }
        
        var result = names.joined(separator: ", ")
        if attendees.count > 3 {
            result += " +\(attendees.count - 3) more"
        }
        return result
    }
    
    private var meetingSummary: String {
        // First, try to show the pre-generated one-liner
        if let oneLiner = meeting.oneLiner, !oneLiner.isEmpty {
            return oneLiner
        }
        
        // Fallback to description
        if let description = meeting.description, !description.isEmpty {
            let trimmed = description.prefix(80)
            return String(trimmed) + (description.count > 80 ? "..." : "")
        }
        return "Tap to view meeting details and prepare"
    }
}

#Preview {
    HomeView()
        .environmentObject(MeetingsViewModel())
}
