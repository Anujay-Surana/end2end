# Fixing Deep Link After Bundle ID Change

## The Problem
After changing the bundle ID from `com.shadow.app` to `com.kordn8.shadow`, iOS doesn't recognize the new URL scheme until you rebuild and reinstall the app.

## Solution Steps

### 1. Delete Old App from Device
- **Important**: Delete the old app completely from your iOS device
- Long press the app icon → Remove App → Delete App
- This ensures iOS clears the old URL scheme registration

### 2. Clean Xcode Build
```bash
cd humanMax-mobile/ios/App
open App.xcworkspace
```

In Xcode:
- **Product** → **Clean Build Folder** (Shift + Cmd + K)
- Close Xcode

### 3. Verify Bundle ID in Xcode
1. Open `App.xcworkspace` in Xcode
2. Select **App** project → **App** target → **General** tab
3. Verify **Bundle Identifier** is: `com.kordn8.shadow`
4. Go to **Signing & Capabilities**
5. Make sure your **Team** is selected
6. Check **"Automatically manage signing"**

### 4. Verify URL Scheme in Info.plist
The URL scheme should already be set, but verify:
- Open `ios/App/App/Info.plist`
- Look for `CFBundleURLSchemes` → should contain `com.kordn8.shadow`

### 5. Rebuild and Reinstall
In Xcode:
1. Select your device (not simulator)
2. **Product** → **Run** (Cmd + R)
3. Wait for the app to install on your device

### 6. Test Deep Link
After reinstalling:
1. Open Safari on your device
2. Type in address bar: `com.kordn8.shadow://test`
3. Tap Go
4. It should ask "Open in Shadow?" → Tap **Open**
5. If it opens the app, the URL scheme is working!

### 7. Test OAuth Flow
1. Open the Shadow app
2. Try signing in
3. Check console logs - you should see:
   - `📱 Native platform detected, setting up app URL listener...`
   - `🔧 Setting up app URL listener for com.kordn8.shadow://...`
   - `✅ App URL listener setup complete`

## If Still Not Working

### Check Console Logs
When you tap "Open Shadow App" button, check Safari console:
- Open Safari on Mac
- **Develop** → **[Your iPhone]** → **[Safari Tab]**
- Look for any errors

### Verify URL Scheme Registration
Test if iOS recognizes the URL scheme:
```bash
# On your Mac, test if the URL scheme is registered
xcrun simctl openurl booted "com.kordn8.shadow://test"
```

### Check AppDelegate
Make sure `AppDelegate.swift` has the URL handling method (it should):
```swift
func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
    return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
}
```

### Nuclear Option: Reset Simulator/Device
If nothing works:
1. Delete app from device
2. Restart device
3. Rebuild and reinstall app

## Expected Console Output

When OAuth callback works, you should see:
```
📱 Native platform detected, setting up app URL listener...
🔧 Setting up app URL listener for com.kordn8.shadow://...
✅ App URL listener setup complete
🎯 appUrlOpen listener triggered!
📥 Received data: {"url":"com.kordn8.shadow://auth/callback?code=..."}
🔗 Received app URL: com.kordn8.shadow://auth/callback?code=...
✅ Confirmed this is our OAuth callback! Processing...
```

If you don't see `🎯 appUrlOpen listener triggered!`, the deep link isn't reaching the app.

