# Swift Migration - Phase 1: Foundation Services

## Overview
Phase 1 of the Capacitor to Swift migration has been completed. All core services have been implemented in native Swift, replacing the Capacitor plugin dependencies.

## Completed Services

### 1. KeychainService.swift ✅
- Secure storage for access tokens and session tokens
- Uses iOS Keychain API (`Security` framework)
- Convenience methods for auth token management
- Service name: `com.kordn8.shadow`

**Key Features:**
- `store(_:forKey:)` - Store any string value securely
- `retrieve(forKey:)` - Retrieve stored values
- `delete(forKey:)` - Delete stored values
- `clearAll()` - Clear all stored values
- Convenience methods: `storeAccessToken()`, `getAccessToken()`, `storeSessionToken()`, etc.

### 2. Constants.swift ✅
- Centralized application constants
- API base URL configuration (with environment variable override)
- Google OAuth Client ID configuration
- OAuth scopes and redirect URI configuration
- WebSocket URL construction

**Key Constants:**
- `apiBaseURL` - Backend API URL (defaults to production)
- `googleClientID` - OAuth client ID (from environment or Info.plist)
- `oauthScopes` - Required OAuth scopes
- `oauthRedirectScheme` - Deep link scheme (`com.kordn8.shadow`)
- `realtimeWebSocketURL` - WebSocket endpoint URL

### 3. Models ✅

#### AuthModels.swift
- `User` - User model matching backend structure
- `AuthResponse` - Authentication response from backend
- `Session` - Session model with token and expiration
- `OAuthCallbackRequest` - OAuth callback request
- `CurrentUserResponse` - Current user API response
- `AccountsResponse` - Connected accounts response
- `Account` - Account model with provider info

#### APIModels.swift
- `APIError` - Generic API error response
- `MeetingsResponse` - Meetings API response
- `Meeting` - Meeting model with all fields
- `MeetingTime` - Meeting time (supports dateTime or date)
- `Attendee` - Attendee model
- `DayPrepResponse` - Day prep API response
- `DayPrep` - Day prep model
- `MeetingPrep` - Meeting prep model
- `ChatMessagesResponse` - Chat messages response
- `ChatMessage` - Chat message model
- `FunctionResult` - AI function result
- `AnyCodable` - Dynamic JSON value handling
- `DeviceRegistrationRequest/Response` - Device registration models
- `DeviceInfo` - Device information model

### 4. APIClient.swift ✅
- HTTP client using URLSession
- Automatic authentication header injection
- Retry logic with exponential backoff
- Error handling and decoding
- Platform header (`X-Platform: ios`)

**Key Features:**
- Request building with authentication
- Retry logic for network errors and 5xx status codes
- Automatic session token refresh handling
- All API endpoints implemented:
  - Auth: `googleCallback()`, `addGoogleAccount()`, `getCurrentUser()`, `logout()`
  - Accounts: `getAccounts()`, `deleteAccount()`, `setPrimaryAccount()`
  - Meetings: `getMeetingsForDay()`, `prepMeeting()`
  - Chat: `getChatMessages()`, `sendChatMessage()`, `deleteChatMessage()`
  - Devices: `registerDevice()`
  - Day Prep: `dayPrep()`

**Error Types:**
- `APIError.networkError(String)`
- `APIError.httpError(Int, String)`
- `APIError.unauthorized(String)`
- `APIError.decodingError(String)`

### 5. AuthService.swift ✅
- OAuth flow using `ASWebAuthenticationSession`
- Deep link callback handling
- Session management
- User state management (`@Published` properties)

**Key Features:**
- `signIn()` - Start OAuth flow
- `handleOAuthCallback(callbackURL:)` - Handle deep link callback
- `checkSession()` - Verify session validity
- `signOut()` - Logout and clear tokens
- State management with `@Published` properties
- CSRF protection with state parameter

**Error Types:**
- `AuthError.configurationError(String)`
- `AuthError.oauthError(String)`
- `AuthError.cancelled`
- `AuthError.networkError(String)`

### 6. RealtimeService.swift ✅
- WebSocket connection management using `URLSessionWebSocketTask`
- OpenAI Realtime API protocol handling
- Message serialization/deserialization
- Connection lifecycle management

**Key Features:**
- `connect()` - Connect to WebSocket endpoint
- `disconnect()` - Close WebSocket connection
- `sendText(_:)` - Send text message
- `sendAudio(_:)` - Send audio data (base64 encoded)
- `sendStop()` - Send stop signal
- Callbacks: `onTranscript`, `onAudio`, `onResponse`, `onError`, `onReady`
- Automatic reconnection handling

**Error Types:**
- `RealtimeError.invalidURL`
- `RealtimeError.notConnected`
- `RealtimeError.encodingError`
- `RealtimeError.decodingError`
- `RealtimeError.serverError(String)`
- `RealtimeError.connectionFailed`

### 7. AudioService.swift ✅
- Low-level audio capture and playback using `AVAudioEngine`
- PCM16 audio format (16kHz, 16-bit)
- Optimized for low latency

**Key Features:**
- `startRecording()` - Start audio capture with permission check
- `stopRecording()` - Stop audio capture
- `startPlayback()` - Start audio playback
- `playAudio(_:)` - Play PCM16 audio data
- `stopPlayback()` - Stop audio playback
- `stopAll()` - Stop all audio operations
- Audio session configuration for voice chat mode
- 5ms buffer duration for ultra-low latency

**Error Types:**
- `AudioError.permissionDenied`
- `AudioError.engineSetupFailed`
- `AudioError.invalidFormat`
- `AudioError.alreadyRecording`
- `AudioError.alreadyPlaying`
- `AudioError.playbackFailed`

### 8. VoiceService.swift ✅
- High-level voice service integrating AudioService with RealtimeService
- Voice recording and realtime API integration
- Transcript and response handling

**Key Features:**
- `start()` - Start voice recording and connect to realtime API
- `stop()` - Stop voice recording and disconnect
- `sendText(_:)` - Send text message to realtime API
- `sendStop()` - Send stop signal
- `checkConnection()` - Check connection status
- `reconnect()` - Reconnect to realtime API
- State management with `@Published` properties
- Automatic audio streaming to WebSocket

**Error Types:**
- `VoiceError.alreadyRecording`
- `VoiceError.notRecording`
- `VoiceError.notConnected`
- `VoiceError.connectionFailed(String)`
- `VoiceError.recordingFailed(String)`
- `VoiceError.permissionDenied`

### 9. NotificationService.swift ✅
- Push notification registration
- Local notification scheduling
- Notification tap handling
- Device registration with backend

**Key Features:**
- `initialize()` - Initialize notification service
- `didRegisterForRemoteNotifications(deviceToken:)` - Handle device token
- `sendNotification(title:body:data:)` - Send immediate notification
- `scheduleMeetingReminder(meeting:minutesBefore:)` - Schedule meeting reminder
- `scheduleDailySummary(hour:minute:)` - Schedule daily summary
- `onNotificationTap(_:)` - Register callback for notification taps
- `UNUserNotificationCenterDelegate` implementation

**Error Types:**
- `NotificationError.permissionDenied`
- `NotificationError.invalidMeetingTime`
- `NotificationError.reminderTimeInPast`
- `NotificationError.schedulingFailed`

### 10. CacheService.swift ✅
- Data caching using UserDefaults
- Meeting cache management
- Sync time tracking
- Generic Codable storage

**Key Features:**
- `cacheMeetings(_:forDate:)` - Cache meetings for date
- `getCachedMeetings(forDate:)` - Retrieve cached meetings
- `saveLastSyncTime(_:)` - Save sync timestamp
- `getLastSyncTime()` - Get last sync time
- `shouldSync(minutesThreshold:)` - Check if sync needed
- Generic `store(_:forKey:)` and `retrieve(forKey:as:)` methods

### 11. BackgroundSyncService.swift ✅
- App lifecycle monitoring
- Automatic calendar data sync
- Cache management integration

**Key Features:**
- `initialize()` - Setup app lifecycle observers
- `syncCalendarData()` - Sync today's meetings
- `getCachedMeetings(forDate:)` - Get cached meetings
- `forceSync()` - Force sync ignoring last sync time
- Automatic sync on app foreground
- State management with `@Published` properties

## AppDelegate Updates ✅

Updated `AppDelegate.swift` to integrate with new services:
- Initialize `NotificationService` on app launch
- Initialize `BackgroundSyncService` on app launch
- Handle push notification registration
- Handle OAuth deep link callbacks

## File Structure

```
humanMax-mobile/ios/App/App/
├── Services/
│   ├── APIClient.swift
│   ├── AudioService.swift
│   ├── AuthService.swift
│   ├── BackgroundSyncService.swift
│   ├── CacheService.swift
│   ├── KeychainService.swift
│   ├── NotificationService.swift
│   ├── RealtimeService.swift
│   └── VoiceService.swift
├── Models/
│   ├── APIModels.swift
│   └── AuthModels.swift
├── Utilities/
│   └── Constants.swift
└── AppDelegate.swift (updated)
```

## Next Steps (Phase 2+)

### Phase 2: UI Integration
- Create SwiftUI views to replace React components
- Integrate services with SwiftUI views
- Implement navigation

### Phase 3: Testing & Validation
- Test OAuth flow end-to-end
- Test WebSocket connection and reconnection
- Test audio capture and playback
- Test push notifications
- Test background sync

### Phase 4: Capacitor Removal
- Remove Capacitor dependencies
- Remove JavaScript bridge code
- Update Podfile
- Clean up unused files

## Dependencies

All services use only native iOS frameworks:
- `Foundation` - Core functionality
- `Security` - Keychain access
- `AVFoundation` - Audio capture/playback
- `UserNotifications` - Push/local notifications
- `UIKit` - App lifecycle
- `AuthenticationServices` - OAuth flow
- `URLSession` - HTTP/WebSocket networking

No external dependencies required!

## Notes

- All services follow singleton pattern for shared access
- Services use `@MainActor` where needed for UI updates
- Error handling is comprehensive with custom error types
- Services are designed to be testable and modular
- Backend compatibility maintained (no backend changes needed)

