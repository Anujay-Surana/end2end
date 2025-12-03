import SwiftUI

// MARK: - Meeting Note Model

struct MeetingNote: Identifiable {
    let id: String
    let meetingId: String
    let meetingTitle: String
    let meetingTime: Date
    let attendees: [String]
    let listenedAt: Date
    let notes: [String]
}

// MARK: - Notes View

struct NotesView: View {
    @State private var selectedNote: MeetingNote?
    
    // Mock data for demonstration
    private let mockNotes: [MeetingNote] = [
        MeetingNote(
            id: "note-1",
            meetingId: "meeting-1",
            meetingTitle: "Q4 Planning Session",
            meetingTime: Calendar.current.date(byAdding: .hour, value: -2, to: Date())!,
            attendees: ["John Smith", "Sarah Johnson"],
            listenedAt: Calendar.current.date(byAdding: .hour, value: -1, to: Date())!,
            notes: [
                "Discussed Q4 targets and KPIs",
                "Sarah proposed new marketing strategy",
                "Budget allocation needs review by Friday",
                "Next steps: Schedule follow-up with finance team"
            ]
        ),
        MeetingNote(
            id: "note-2",
            meetingId: "meeting-2",
            meetingTitle: "Product Roadmap Review",
            meetingTime: Calendar.current.date(byAdding: .day, value: -1, to: Date())!,
            attendees: ["Mike Brown", "Lisa Chen", "David Wilson"],
            listenedAt: Calendar.current.date(byAdding: .day, value: -1, to: Date())!,
            notes: [
                "Feature prioritization for Q1 2025",
                "Mobile app redesign timeline confirmed",
                "API v2 launch scheduled for January",
                "Action item: Create technical spec document"
            ]
        ),
        MeetingNote(
            id: "note-3",
            meetingId: "meeting-3",
            meetingTitle: "Client Onboarding Call",
            meetingTime: Calendar.current.date(byAdding: .day, value: -2, to: Date())!,
            attendees: ["James from Acme Corp"],
            listenedAt: Calendar.current.date(byAdding: .day, value: -2, to: Date())!,
            notes: [
                "Client interested in enterprise plan",
                "Main pain point: current tool lacks integration",
                "Demo scheduled for next week",
                "Send pricing proposal by Thursday"
            ]
        )
    ]
    
    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // Header
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Notes")
                            .font(.system(size: 28, weight: .bold))
                            .foregroundColor(.primary)
                        
                        Text("Meeting recordings & insights")
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal)
                    .padding(.top, 8)
                    
                    if mockNotes.isEmpty {
                        emptyStateView
                    } else {
                        timelineView
                    }
                }
                .padding(.vertical)
            }
            .navigationBarHidden(true)
        }
        .sheet(item: $selectedNote) { note in
            NoteDetailView(note: note)
        }
    }
    
    // MARK: - Subviews
    
    private var emptyStateView: some View {
        VStack(spacing: 16) {
            Image(systemName: "note.text")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            
            Text("No notes yet")
                .font(.headline)
            
            Text("Notes from your listened meetings will appear here")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
        .padding(.horizontal)
    }
    
    private var timelineView: some View {
        VStack(alignment: .leading, spacing: 24) {
            ForEach(groupedNotes.keys.sorted(by: >), id: \.self) { dateKey in
                VStack(alignment: .leading, spacing: 12) {
                    // Date header
                    Text(formatDateHeader(dateKey))
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundColor(.secondary)
                        .textCase(.uppercase)
                        .tracking(0.5)
                        .padding(.horizontal)
                    
                    // Timeline items
                    VStack(spacing: 0) {
                        ForEach(groupedNotes[dateKey] ?? []) { note in
                            TimelineNoteCard(note: note)
                                .onTapGesture {
                                    selectedNote = note
                                }
                        }
                    }
                    .padding(.leading, 24)
                }
            }
        }
    }
    
    // MARK: - Helpers
    
    private var groupedNotes: [Date: [MeetingNote]] {
        let calendar = Calendar.current
        var groups: [Date: [MeetingNote]] = [:]
        
        for note in mockNotes {
            let dateKey = calendar.startOfDay(for: note.listenedAt)
            if groups[dateKey] == nil {
                groups[dateKey] = []
            }
            groups[dateKey]?.append(note)
        }
        
        return groups
    }
    
    private func formatDateHeader(_ date: Date) -> String {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
        
        if calendar.isDate(date, inSameDayAs: today) {
            return "Today"
        } else if calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday"
        } else {
            let formatter = DateFormatter()
            formatter.dateFormat = "EEEE, MMMM d"
            return formatter.string(from: date)
        }
    }
}

// MARK: - Timeline Note Card

struct TimelineNoteCard: View {
    let note: MeetingNote
    
    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            // Timeline dot and line
            VStack(spacing: 0) {
                Circle()
                    .fill(Color.black)
                    .frame(width: 10, height: 10)
                
                Rectangle()
                    .fill(Color.gray.opacity(0.3))
                    .frame(width: 2)
            }
            
            // Card content
            VStack(alignment: .leading, spacing: 8) {
                Text(formatTime(note.meetingTime))
                    .font(.caption)
                    .foregroundColor(.secondary)
                
                Text(note.meetingTitle)
                    .font(.body)
                    .fontWeight(.semibold)
                    .foregroundColor(.primary)
                
                if let firstNote = note.notes.first {
                    Text(firstNote)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                }
                
                Text("\(note.notes.count) notes captured")
                    .font(.caption)
                    .foregroundColor(.gray)
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.systemBackground))
            .cornerRadius(12)
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.gray.opacity(0.2), lineWidth: 1)
            )
            .padding(.trailing)
            .padding(.bottom, 12)
        }
    }
    
    private func formatTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

// MARK: - Note Detail View

struct NoteDetailView: View {
    let note: MeetingNote
    @Environment(\.dismiss) private var dismiss
    
    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // Title
                    Text(note.meetingTitle)
                        .font(.title2)
                        .fontWeight(.bold)
                    
                    // Meta info
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 8) {
                            Image(systemName: "clock")
                                .foregroundColor(.secondary)
                            Text(formatDateTime(note.meetingTime))
                                .font(.subheadline)
                                .foregroundColor(.secondary)
                        }
                        
                        if !note.attendees.isEmpty {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: "person.2")
                                    .foregroundColor(.secondary)
                                Text(note.attendees.prefix(3).joined(separator: ", ") + (note.attendees.count > 3 ? " +\(note.attendees.count - 3) more" : ""))
                                    .font(.subheadline)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    .padding(.bottom, 8)
                    
                    Divider()
                    
                    // In-Meeting Notes
                    VStack(alignment: .leading, spacing: 12) {
                        Text("In-Meeting Notes")
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundColor(.secondary)
                            .textCase(.uppercase)
                            .tracking(0.5)
                        
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(note.notes, id: \.self) { noteText in
                                HStack(alignment: .top, spacing: 8) {
                                    Text("•")
                                        .fontWeight(.bold)
                                    Text(noteText)
                                        .font(.body)
                                }
                                .padding(.vertical, 4)
                            }
                        }
                    }
                    
                    Divider()
                    
                    // Recorded timestamp
                    HStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("Recorded on \(formatDateTime(note.listenedAt))")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                .padding()
            }
            .navigationTitle("Meeting Notes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { dismiss() }) {
                        Image(systemName: "chevron.left")
                            .foregroundColor(.primary)
                    }
                }
            }
        }
    }
    
    private func formatDateTime(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

#Preview {
    NotesView()
}
