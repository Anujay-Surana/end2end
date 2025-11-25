# iOS Setup Instructions

## Prerequisites

- Xcode installed (latest version recommended)
- Apple Developer account (for push notifications and App Store distribution)
- CocoaPods installed (usually comes with Capacitor iOS)

## Initial Setup

1. **Build the web app**
   ```bash
   npm run build
   ```

2. **Sync with Capacitor**
   ```bash
   npx cap sync
   ```

3. **Open in Xcode**
   ```bash
   npx cap open ios
   ```

## Xcode Configuration

### 1. Bundle Identifier

1. Select the project in Xcode navigator
2. Select the "App" target
3. Go to "General" tab
4. Set Bundle Identifier (e.g., `com.humanmax.app`)
5. Set Display Name: "HumanMax"
6. Set Version and Build numbers

### 2. Signing & Capabilities

1. Go to "Signing & Capabilities" tab
2. Select your Team
3. Check "Automatically manage signing"
4. Xcode will generate provisioning profiles automatically

### 3. Add Push Notifications Capability

1. In "Signing & Capabilities" tab
2. Click "+ Capability"
3. Search for "Push Notifications"
4. Add it to your app

### 4. Background Modes (Optional)

If you want background refresh:
1. Click "+ Capability"
2. Search for "Background Modes"
3. Check "Background fetch"
4. Check "Remote notifications"

## Apple Developer Portal Configuration

### 1. App ID Configuration

1. Go to [Apple Developer Portal](https://developer.apple.com/account/)
2. Navigate to "Certificates, Identifiers & Profiles"
3. Go to "Identifiers" → "App IDs"
4. Find or create your App ID (matching Bundle Identifier)
5. Enable "Push Notifications" capability
6. Save changes

### 2. APNs Key Setup

1. In Apple Developer Portal, go to "Keys"
2. Click "+" to create a new key
3. Name it (e.g., "HumanMax APNs Key")
4. Enable "Apple Push Notifications service (APNs)"
5. Click "Continue" and "Register"
6. Download the key file (`.p8`)
7. Note the Key ID and Team ID

### 3. Provisioning Profile

If using manual signing:
1. Go to "Profiles" in Apple Developer Portal
2. Create new profile for your App ID
3. Select certificates and devices
4. Download and install in Xcode

## Testing on Device

### 1. Connect Physical Device

1. Connect your iPhone/iPad via USB
2. Trust the computer on your device
3. In Xcode, select your device from the device dropdown
4. Click "Run" (▶️)

### 2. Enable Developer Mode (iOS 16+)

1. On your device, go to Settings → Privacy & Security
2. Scroll to "Developer Mode"
3. Enable Developer Mode
4. Restart device if prompted

### 3. Trust Developer Certificate

1. On device, go to Settings → General → VPN & Device Management
2. Tap on your developer certificate
3. Tap "Trust"

## Push Notifications Testing

### 1. Register Device Token

The app will automatically register for push notifications on launch. Check the console logs for the device token.

### 2. Send Test Notification

You can test push notifications using:
- Apple's Push Notification Console (requires APNs key)
- Your backend server (if configured)
- Third-party services like Pusher or OneSignal

### 3. Verify Permissions

1. On device, go to Settings → HumanMax → Notifications
2. Ensure notifications are enabled
3. Check notification styles and sounds

## Building for Distribution

### 1. Archive

1. In Xcode, select "Any iOS Device" or "Generic iOS Device"
2. Go to Product → Archive
3. Wait for archive to complete

### 2. Distribute

1. In Organizer window, select your archive
2. Click "Distribute App"
3. Choose distribution method:
   - App Store Connect (for App Store)
   - Ad Hoc (for testing)
   - Enterprise (for enterprise distribution)
4. Follow the wizard to complete distribution

## Troubleshooting

### Build Errors

- **"No such module 'Capacitor'"**: Run `npx cap sync` again
- **Signing errors**: Check Team selection and provisioning profiles
- **CocoaPods errors**: Run `cd ios && pod install`

### Push Notification Issues

- **No device token**: Check that Push Notifications capability is added
- **Permission denied**: Check Info.plist for notification permission strings
- **Notifications not received**: Verify APNs configuration and device token registration

### Runtime Errors

- **CORS errors**: Ensure backend CORS allows Capacitor origins
- **Session errors**: Check that cookies are enabled and backend session configuration
- **Network errors**: Verify API URL in `capacitor.config.ts`

## Next Steps

After setup:
1. Test authentication flow
2. Test calendar sync
3. Test push notifications on physical device
4. Test background sync
5. Prepare for App Store submission

