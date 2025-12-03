import SwiftUI

struct DayPrepView: View {
    let date: Date
    @State private var dayPrep: DayPrep?
    @State private var isLoading = false
    @State private var errorMessage: String?
    
    var body: some View {
        NavigationView {
            ScrollView {
                if isLoading {
                    ProgressView("Loading day prep...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let prep = dayPrep {
                    VStack(alignment: .leading, spacing: 20) {
                        Text(prep.summary)
                            .font(.body)
                        
                        if let meetings = prep.prep, !meetings.isEmpty {
                            Text("Meeting Preps")
                                .font(.headline)
                            
                            ForEach(meetings, id: \.meetingTitle) { meetingPrep in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(meetingPrep.meetingTitle)
                                        .font(.subheadline)
                                        .fontWeight(.semibold)
                                    
                                    ForEach(meetingPrep.sections, id: \.title) { section in
                                        Text(section.title)
                                            .font(.caption)
                                            .fontWeight(.medium)
                                        Text(section.content)
                                            .font(.caption)
                                            .foregroundColor(.secondary)
                                    }
                                }
                                .padding()
                                .background(Color.gray.opacity(0.1))
                                .cornerRadius(8)
                            }
                        }
                    }
                    .padding()
                } else if let error = errorMessage {
                    Text("Error: \(error)")
                        .foregroundColor(.red)
                }
            }
            .navigationTitle("Day Prep")
            .task {
                await loadDayPrep()
            }
        }
    }
    
    private func loadDayPrep() async {
        isLoading = true
        errorMessage = nil
        
        let dateStr = formatDate(date)
        
        do {
            let response = try await APIClient.shared.dayPrep(date: dateStr)
            dayPrep = response.dayPrep
        } catch {
            errorMessage = error.localizedDescription
        }
        
        isLoading = false
    }
    
    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}

