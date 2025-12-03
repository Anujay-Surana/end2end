import SwiftUI

struct MeetingPrepView: View {
    let meeting: Meeting
    @Environment(\.dismiss) var dismiss
    @StateObject private var chatViewModel = ChatViewModel()
    
    var body: some View {
        NavigationView {
            VStack {
                if chatViewModel.generatingBrief {
                    VStack(spacing: 16) {
                        ProgressView()
                        Text("Generating meeting brief...")
                            .font(.headline)
                    }
                } else {
                    ChatView()
                        .environmentObject(chatViewModel)
                }
            }
            .navigationTitle(meeting.title ?? meeting.summary)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .task {
                await chatViewModel.prepMeeting(meeting)
            }
        }
    }
}

