import Foundation
import UIKit

/// Service for syncing data when app comes to foreground
@MainActor
class BackgroundSyncService: ObservableObject {
    static let shared = BackgroundSyncService()
    
    @Published var isSyncing = false
    @Published var lastSyncTime: Date?
    
    private let apiClient: APIClient
    private let cacheService: CacheService
    private var syncInProgress = false
    private var observers: [NSObjectProtocol] = []
    
    private init() {
        self.apiClient = APIClient.shared
        self.cacheService = CacheService.shared
        self.lastSyncTime = cacheService.getLastSyncTime()
    }
    
    // MARK: - Initialization
    
    /// Initialize background sync service
    func initialize() {
        // Listen for app lifecycle notifications
        let willEnterForegroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                await self?.syncCalendarData()
            }
        }
        
        observers.append(willEnterForegroundObserver)
        
        // Also sync when app becomes active
        let didBecomeActiveObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                await self?.syncCalendarData()
            }
        }
        
        observers.append(didBecomeActiveObserver)
    }
    
    /// Cleanup observers
    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }
    
    // MARK: - Sync
    
    /// Sync calendar data for today
    func syncCalendarData() async {
        guard !syncInProgress else { return }
        
        // Check if we should sync
        guard cacheService.shouldSync() else {
            return
        }
        
        syncInProgress = true
        isSyncing = true
        
        defer {
            syncInProgress = false
            isSyncing = false
        }
        
        do {
            // Check if user is authenticated
            _ = try await apiClient.getCurrentUser()
            
            // Get today's date
            let today = Date()
            let dateStr = formatDate(today)
            
            // Fetch today's meetings
            let response = try await apiClient.getMeetingsForDay(date: dateStr)
            
            // Cache the meetings
            cacheService.cacheMeetings(response.meetings, forDate: dateStr)
            
            // Update last sync time
            let now = Date()
            cacheService.saveLastSyncTime(now)
            lastSyncTime = now
            
            print("Calendar data synced successfully")
        } catch {
            // Only log if it's not an authentication error
            if let apiError = error as? APIError {
                switch apiError {
                case .unauthorized:
                    // User not authenticated, skip sync
                    return
                default:
                    print("Error syncing calendar data: \(apiError.message)")
                }
            } else {
                print("Error syncing calendar data: \(error.localizedDescription)")
            }
        }
    }
    
    /// Get cached meetings for a date
    func getCachedMeetings(forDate date: String) -> [Meeting]? {
        return cacheService.getCachedMeetings(forDate: date)
    }
    
    /// Format date as YYYY-MM-DD
    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
    
    /// Force sync (ignore last sync time check)
    func forceSync() async {
        syncInProgress = false // Reset flag to allow sync
        await syncCalendarData()
    }
}

