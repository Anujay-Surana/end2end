import SwiftUI

struct CalendarView: View {
    @EnvironmentObject var meetingsViewModel: MeetingsViewModel
    @State private var selectedDate = Date()
    @State private var selectedMeeting: Meeting?
    
    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                // Date picker
                DatePicker("Select Date", selection: $selectedDate, displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .padding()
                    .onChange(of: selectedDate) { newDate in
                        meetingsViewModel.selectedDate = newDate
                        Task {
                            await meetingsViewModel.loadMeetings(for: newDate)
                        }
                    }
                
                Divider()
                
                // Meetings list
                if meetingsViewModel.isLoading {
                    Spacer()
                    ProgressView("Loading meetings...")
                    Spacer()
                } else if meetingsViewModel.meetings.isEmpty {
                    Spacer()
                    VStack(spacing: 8) {
                        Image(systemName: "calendar.badge.exclamationmark")
                            .font(.system(size: 50))
                            .foregroundColor(.gray)
                        Text("No meetings scheduled")
                            .font(.headline)
                            .foregroundColor(.secondary)
                    }
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(meetingsViewModel.meetings) { meeting in
                                MeetingRow(meeting: meeting)
                                    .onTapGesture {
                                        selectedMeeting = meeting
                                    }
                            }
                        }
                        .padding()
                    }
                }
            }
            .navigationTitle("Calendar")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(action: {
                        Task {
                            await meetingsViewModel.refreshMeetings()
                        }
                    }) {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .sheet(item: $selectedMeeting) { meeting in
                MeetingDetailView(meeting: meeting)
            }
            .task {
                await meetingsViewModel.loadMeetings(for: selectedDate)
            }
        }
    }
}

struct MeetingRow: View {
    let meeting: Meeting
    
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(meeting.title ?? meeting.summary)
                    .font(.headline)
                
                Spacer()
                
                if let start = meeting.start, let startTime = parseTime(start) {
                    Text(startTime)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
            }
            
            if let description = meeting.description {
                Text(description)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
            }
            
            if let location = meeting.location {
                HStack {
                    Image(systemName: "mappin.circle.fill")
                        .font(.caption)
                    Text(location)
                        .font(.caption)
                }
                .foregroundColor(.secondary)
            }
        }
        .padding()
        .background(Color.gray.opacity(0.1))
        .cornerRadius(10)
    }
    
    private func parseTime(_ meetingTime: MeetingTime) -> String? {
        if let dateTimeString = meetingTime.dateTime {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            
            if let date = formatter.date(from: dateTimeString) ?? ISO8601DateFormatter().date(from: dateTimeString) {
                let timeFormatter = DateFormatter()
                timeFormatter.timeStyle = .short
                return timeFormatter.string(from: date)
            }
        }
        return nil
    }
}

struct MeetingDetailView: View {
    let meeting: Meeting
    @Environment(\.dismiss) var dismiss
    @StateObject private var chatViewModel = ChatViewModel()
    
    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(meeting.title ?? meeting.summary)
                        .font(.title)
                        .fontWeight(.bold)
                    
                    if let description = meeting.description {
                        Text(description)
                            .font(.body)
                    }
                    
                    if let start = meeting.start, let startTime = formatDateTime(start) {
                        Label(startTime, systemImage: "clock")
                    }
                    
                    if let location = meeting.location {
                        Label(location, systemImage: "mappin.circle.fill")
                    }
                    
                    Divider()
                    
                    Button(action: {
                        Task {
                            await chatViewModel.prepMeeting(meeting)
                            dismiss()
                        }
                    }) {
                        HStack {
                            Image(systemName: "sparkles")
                            Text("Prep Meeting")
                        }
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.blue)
                        .foregroundColor(.white)
                        .cornerRadius(10)
                    }
                    .disabled(chatViewModel.generatingBrief)
                }
                .padding()
            }
            .navigationTitle("Meeting Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
    
    private func formatDateTime(_ meetingTime: MeetingTime) -> String? {
        if let dateTimeString = meetingTime.dateTime {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            
            if let date = formatter.date(from: dateTimeString) ?? ISO8601DateFormatter().date(from: dateTimeString) {
                let dateFormatter = DateFormatter()
                dateFormatter.dateStyle = .medium
                dateFormatter.timeStyle = .short
                return dateFormatter.string(from: date)
            }
        }
        return nil
    }
}

