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
        
        // Try cache first
        if let cachedMeetings = cacheService.getCachedMeetings(forDate: dateStr) {
            meetings = cachedMeetings
            isLoading = false
        }
        
        do {
            let response = try await apiClient.getMeetingsForDay(date: dateStr)
            meetings = response.meetings
            
            // Cache meetings
            cacheService.cacheMeetings(meetings, forDate: dateStr)
        } catch {
            errorMessage = error.localizedDescription
            // Keep cached meetings if available
            if meetings.isEmpty {
                if let cachedMeetings = cacheService.getCachedMeetings(forDate: dateStr) {
                    meetings = cachedMeetings
                }
            }
        }
        
        isLoading = false
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
