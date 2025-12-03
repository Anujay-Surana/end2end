import Foundation
import SwiftUI

@MainActor
class MeetingsViewModel: ObservableObject {
    @Published var meetings: [Meeting] = []
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var selectedDate = Date()
    
    private let apiClient = APIClient.shared
    private let cacheService = CacheService.shared
    
    func loadMeetings(for date: Date) async {
        isLoading = true
        errorMessage = nil
        
        let dateStr = formatDate(date)
        
        // Try cache first for immediate display
        if let cachedMeetings = cacheService.getCachedMeetings(forDate: dateStr) {
            meetings = cachedMeetings
        }
        
        do {
            print("📅 Loading meetings for date: \(dateStr)")
            let response = try await apiClient.getMeetingsForDay(date: dateStr)
            print("✅ Received \(response.meetings.count) meetings from API")
            
            // Filter out meetings that don't have required fields
            let validMeetings = response.meetings.filter { meeting in
                !meeting.id.isEmpty && !meeting.summary.isEmpty
            }
            
            print("✅ Valid meetings after filtering: \(validMeetings.count)")
            
            if validMeetings.isEmpty && !response.meetings.isEmpty {
                print("⚠️ All meetings were filtered out - checking first meeting structure:")
                if let firstMeeting = response.meetings.first {
                    print("   Meeting ID: \(firstMeeting.id)")
                    print("   Meeting Summary: \(firstMeeting.summary)")
                    print("   Meeting Title: \(firstMeeting.title ?? "nil")")
                }
            }
            
            meetings = validMeetings
            
            // Cache meetings
            cacheService.cacheMeetings(meetings, forDate: dateStr)
        } catch {
            print("❌ Error loading meetings: \(error)")
            errorMessage = error.localizedDescription
            // Keep cached meetings if available and API call failed
            if meetings.isEmpty {
                if let cachedMeetings = cacheService.getCachedMeetings(forDate: dateStr) {
                    print("📦 Using cached meetings: \(cachedMeetings.count)")
                    meetings = cachedMeetings
                }
            }
        }
        
        // Set loading to false only after API call completes
        isLoading = false
        print("📅 Finished loading meetings. Total: \(meetings.count), Loading: \(isLoading)")
    }
    
    func refreshMeetings() async {
        await loadMeetings(for: selectedDate)
    }
    
    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
