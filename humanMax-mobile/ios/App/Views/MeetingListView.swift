import SwiftUI

// This view is integrated into CalendarView, keeping for potential future use
struct MeetingListView: View {
    let meetings: [Meeting]
    let onMeetingSelected: (Meeting) -> Void
    
    var body: some View {
        List(meetings) { meeting in
            MeetingRow(meeting: meeting)
                .onTapGesture {
                    onMeetingSelected(meeting)
                }
        }
    }
}

