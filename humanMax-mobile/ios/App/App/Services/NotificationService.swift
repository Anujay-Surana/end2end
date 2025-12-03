import Foundation
import UserNotifications
import UIKit

/// Service for managing push notifications and local notifications
@MainActor
class NotificationService: NSObject, ObservableObject {
    static let shared = NotificationService()
    
    @Published var deviceToken: String?
    @Published var isInitialized = false
    
    private let apiClient: APIClient
    private var notificationTapCallbacks: [(NotificationData) -> Void] = []
    
    private override init() {
        self.apiClient = APIClient.shared
        super.init()
    }
    
    // MARK: - Initialization
    
    /// Set up the notification delegate synchronously (must be called early in app lifecycle)
    func setupDelegate() {
        // Set delegate synchronously to ensure notifications are handled even during app startup
        UNUserNotificationCenter.current().delegate = self
    }
    
    /// Initialize notification service (async parts: authorization and registration)
    func initialize() async {
        guard !isInitialized else { return }
        
            // Request authorization
            do {
                let granted = try await requestAuthorization()
                guard granted else {
                    print("Notification permission not granted")
                    return
                }
                
                // Register for remote notifications (only if Push Notifications capability is enabled)
                // This will fail gracefully if Push Notifications is not available (e.g., free Apple Developer account)
                await MainActor.run {
                    // Check if Push Notifications capability is available
                    // If not available, this will fail silently, which is fine for development
                    UIApplication.shared.registerForRemoteNotifications()
                }
                
                isInitialized = true
            } catch {
                print("Error initializing notifications: \(error)")
                // Still mark as initialized if local notifications are available
                // Remote notifications may fail on free developer accounts
                isInitialized = true
            }
    }
    
    /// Request notification authorization
    private func requestAuthorization() async throws -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
        return granted
    }
    
    // MARK: - Device Token Management
    
    /// Handle device token registration (called from AppDelegate)
    func didRegisterForRemoteNotifications(deviceToken: Data) {
        let tokenParts = deviceToken.map { data in String(format: "%02.2hhx", data) }
        let token = tokenParts.joined()
        
        self.deviceToken = token
        
        // Save to UserDefaults
        UserDefaults.standard.set(token, forKey: "device_token")
        
        // Register with backend
        Task {
            await registerDeviceWithBackend(token: token)
        }
    }
    
    /// Handle registration error
    func didFailToRegisterForRemoteNotifications(error: Error) {
        print("Failed to register for remote notifications: \(error)")
    }
    
    /// Register device token with backend
    private func registerDeviceWithBackend(token: String) async {
        do {
            let timezone = TimeZone.current.identifier
            let deviceInfo = DeviceInfo(
                platform: "ios",
                appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
            )
            
            _ = try await apiClient.registerDevice(
                deviceToken: token,
                platform: "ios",
                timezone: timezone,
                deviceInfo: deviceInfo
            )
            
            print("Device registered with backend")
        } catch {
            print("Error registering device with backend: \(error)")
        }
    }
    
    /// Get stored device token
    func getDeviceToken() -> String? {
        if let token = deviceToken {
            return token
        }
        return UserDefaults.standard.string(forKey: "device_token")
    }
    
    // MARK: - Local Notifications
    
    /// Send a local notification immediately
    func sendNotification(title: String, body: String, data: [String: Any]? = nil) async throws {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        
        if let data = data {
            content.userInfo = data
        }
        
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil // nil trigger = immediate
        )
        
        try await UNUserNotificationCenter.current().add(request)
    }
    
    /// Schedule a local notification for a meeting reminder
    func scheduleMeetingReminder(meeting: Meeting, minutesBefore: Int = 15) async throws {
        guard let start = meeting.start,
              let startTime = parseMeetingTime(start) else {
            throw NotificationError.invalidMeetingTime
        }
        
        let reminderTime = startTime.addingTimeInterval(-Double(minutesBefore * 60))
        let now = Date()
        
        guard reminderTime > now else {
            throw NotificationError.reminderTimeInPast
        }
        
        let content = UNMutableNotificationContent()
        content.title = meeting.title ?? meeting.summary
        content.body = "Your meeting starts in \(minutesBefore) minutes"
        content.sound = .default
        content.userInfo = [
            "type": "meeting_reminder",
            "meeting_id": meeting.id,
            "minutes_before": minutesBefore
        ]
        
        let dateComponents = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute],
            from: reminderTime
        )
        
        let trigger = UNCalendarNotificationTrigger(dateMatching: dateComponents, repeats: false)
        
        // Use meeting ID as identifier (convert to numeric if possible)
        let identifier = meeting.id.replacingOccurrences(of: "[^0-9]", with: "", options: .regularExpression)
        let finalIdentifier = identifier.isEmpty ? String(Int(reminderTime.timeIntervalSince1970)) : identifier
        
        let request = UNNotificationRequest(
            identifier: finalIdentifier,
            content: content,
            trigger: trigger
        )
        
        try await UNUserNotificationCenter.current().add(request)
        print("Scheduled reminder for meeting \"\(meeting.title ?? meeting.summary)\" at \(reminderTime)")
    }
    
    /// Schedule daily summary notification
    func scheduleDailySummary(hour: Int = 8, minute: Int = 0) async throws {
        var dateComponents = DateComponents()
        dateComponents.hour = hour
        dateComponents.minute = minute
        
        let content = UNMutableNotificationContent()
        content.title = "Daily Summary"
        content.body = "Your daily meeting summary is ready"
        content.sound = .default
        content.userInfo = [
            "type": "daily_summary"
        ]
        
        let trigger = UNCalendarNotificationTrigger(dateMatching: dateComponents, repeats: true)
        
        let request = UNNotificationRequest(
            identifier: "daily_summary",
            content: content,
            trigger: trigger
        )
        
        try await UNUserNotificationCenter.current().add(request)
        
        // Save preference
        UserDefaults.standard.set(["hour": hour, "minute": minute], forKey: "daily_summary_time")
    }
    
    /// Cancel a scheduled notification
    func cancelNotification(identifier: String) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [identifier])
    }
    
    /// Cancel all scheduled notifications
    func cancelAllNotifications() {
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
    }
    
    // MARK: - Notification Tap Handling
    
    /// Register callback for notification taps
    func onNotificationTap(_ callback: @escaping (NotificationData) -> Void) -> () -> Void {
        notificationTapCallbacks.append(callback)
        
        // Return unsubscribe function
        return { [weak self] in
            guard let self = self else { return }
            if let index = self.notificationTapCallbacks.firstIndex(where: { $0 as AnyObject === callback as AnyObject }) {
                self.notificationTapCallbacks.remove(at: index)
            }
        }
    }
    
    /// Handle notification tap
    private func handleNotificationTap(data: NotificationData) {
        notificationTapCallbacks.forEach { callback in
            callback(data)
        }
    }
    
    // MARK: - Helpers
    
    /// Parse meeting time from MeetingTime struct
    private func parseMeetingTime(_ meetingTime: MeetingTime?) -> Date? {
        guard let meetingTime = meetingTime else { return nil }
        
        if let dateTimeString = meetingTime.dateTime {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.date(from: dateTimeString) ?? ISO8601DateFormatter().date(from: dateTimeString)
        }
        
        if let dateString = meetingTime.date {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            return formatter.date(from: dateString)
        }
        
        return nil
    }
}

// MARK: - UNUserNotificationCenterDelegate

@MainActor
extension NotificationService: UNUserNotificationCenterDelegate {
    /// Handle notification when app is in foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Show notification even when app is in foreground
        completionHandler([.banner, .sound, .badge])
    }
    
    /// Handle notification tap
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        
        let data = NotificationData(
            type: userInfo["type"] as? String ?? "unknown",
            meetingId: userInfo["meeting_id"] as? String,
            data: userInfo
        )
        
        handleNotificationTap(data: data)
        completionHandler()
    }
}

// MARK: - Notification Data Model

struct NotificationData {
    let type: String
    let meetingId: String?
    let data: [AnyHashable: Any]
}

// MARK: - Notification Error Types

enum NotificationError: Error, LocalizedError {
    case permissionDenied
    case invalidMeetingTime
    case reminderTimeInPast
    case schedulingFailed
    
    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            return "Notification permission denied"
        case .invalidMeetingTime:
            return "Invalid meeting time"
        case .reminderTimeInPast:
            return "Reminder time is in the past"
        case .schedulingFailed:
            return "Failed to schedule notification"
        }
    }
}
