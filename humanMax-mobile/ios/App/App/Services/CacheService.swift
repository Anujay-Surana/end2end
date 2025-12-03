import Foundation

/// Service for caching data using UserDefaults
class CacheService {
    static let shared = CacheService()
    
    private let userDefaults: UserDefaults
    
    private init() {
        self.userDefaults = UserDefaults.standard
    }
    
    // MARK: - Meeting Cache
    
    /// Cache meetings for a specific date
    func cacheMeetings(_ meetings: [Meeting], forDate date: String) {
        let key = "meetings_\(date)"
        if let encoded = try? JSONEncoder().encode(meetings) {
            userDefaults.set(encoded, forKey: key)
        }
    }
    
    /// Get cached meetings for a specific date
    func getCachedMeetings(forDate date: String) -> [Meeting]? {
        let key = "meetings_\(date)"
        guard let data = userDefaults.data(forKey: key),
              let meetings = try? JSONDecoder().decode([Meeting].self, from: data) else {
            return nil
        }
        return meetings
    }
    
    /// Clear cached meetings for a specific date
    func clearMeetings(forDate date: String) {
        let key = "meetings_\(date)"
        userDefaults.removeObject(forKey: key)
    }
    
    /// Clear all cached meetings
    func clearAllMeetings() {
        let keys = userDefaults.dictionaryRepresentation().keys.filter { $0.hasPrefix("meetings_") }
        keys.forEach { userDefaults.removeObject(forKey: $0) }
    }
    
    // MARK: - Sync Time Cache
    
    /// Save last sync time
    func saveLastSyncTime(_ date: Date) {
        userDefaults.set(date, forKey: "last_sync_time")
    }
    
    /// Get last sync time
    func getLastSyncTime() -> Date? {
        return userDefaults.object(forKey: "last_sync_time") as? Date
    }
    
    /// Check if should sync (based on last sync time)
    func shouldSync(minutesThreshold: Int = 15) -> Bool {
        guard let lastSync = getLastSyncTime() else {
            return true
        }
        
        let now = Date()
        let diffMinutes = now.timeIntervalSince(lastSync) / 60.0
        return diffMinutes > Double(minutesThreshold)
    }
    
    // MARK: - Generic Cache
    
    /// Store any Codable value
    func store<T: Codable>(_ value: T, forKey key: String) {
        if let encoded = try? JSONEncoder().encode(value) {
            userDefaults.set(encoded, forKey: key)
        }
    }
    
    /// Retrieve any Codable value
    func retrieve<T: Codable>(forKey key: String, as type: T.Type) -> T? {
        guard let data = userDefaults.data(forKey: key),
              let value = try? JSONDecoder().decode(T.self, from: data) else {
            return nil
        }
        return value
    }
    
    /// Remove cached value
    func remove(forKey key: String) {
        userDefaults.removeObject(forKey: key)
    }
    
    /// Clear all cache
    func clearAll() {
        if let bundleID = Bundle.main.bundleIdentifier {
            userDefaults.removePersistentDomain(forName: bundleID)
        }
    }
}

