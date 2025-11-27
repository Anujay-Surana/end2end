# TestFlight Setup Guide for Shadow iOS App

This guide will walk you through setting up your Shadow app for TestFlight distribution.

## Prerequisites

1. **Apple Developer Account** ($99/year)
   - Sign up at https://developer.apple.com/programs/
   - You'll need an active Apple Developer Program membership

2. **Xcode** (latest version recommended)
   - Download from Mac App Store
   - Make sure you're signed in with your Apple Developer account

## Step 1: Configure App in Xcode

### 1.1 Open the Project
```bash
cd humanMax-mobile/ios/App
open App.xcworkspace
```

**Important:** Always open `.xcworkspace`, not `.xcodeproj` (because of CocoaPods)

### 1.2 Set Bundle Identifier
1. Select the **App** project in the navigator
2. Select the **App** target
3. Go to **General** tab
4. Verify **Bundle Identifier** is: `com.kordn8.shadow`
   - This should already be set (matches `capacitor.config.ts`)
   - If it shows `com.humanmax.app` or `com.shadow.app`, change it to `com.kordn8.shadow`
   - This must match your App Store Connect app ID

### 1.3 Set Version and Build Number
1. In the **General** tab:
   - **Version**: `1.0.0` (or your current version)
   - **Build**: `1` (increment this for each TestFlight upload)

### 1.4 Configure Signing & Capabilities
1. Go to **Signing & Capabilities** tab:
   1. Check **"Automatically manage signing"**
   2. Select your **Team** (your Apple Developer account)
   3. Xcode will automatically create provisioning profiles

### 1.5 Verify Capabilities
   Make sure these are enabled (if needed):
   - **Push Notifications** (for notifications)
   - **Background Modes** (already configured in Info.plist)
   - **Associated Domains** (if using universal links)

## Step 2: Create App in App Store Connect

### 2.1 Access App Store Connect
1. Go to https://appstoreconnect.apple.com
2. Sign in with your Apple Developer account
3. Click **"My Apps"** → **"+"** → **"New App"**

### 2.2 Fill App Information
- **Platform**: iOS
- **Name**: Shadow
- **Primary Language**: English
- **Bundle ID**: `com.kordn8.shadow` (must match Xcode)
- **SKU**: `shadow-ios-001` (unique identifier, can be anything)
- **User Access**: Full Access (or Limited Access if you have a team)

### 2.3 Complete App Information
Fill in:
- **App Privacy**: Answer privacy questions about data collection
- **App Information**: Description, keywords, support URL, etc.
- **Pricing**: Set to Free (or paid if you want)

**Note:** You can fill these out later, but you need the app record created first.

## Step 3: Build and Archive

### 3.1 Clean Build Folder
In Xcode:
1. **Product** → **Clean Build Folder** (Shift + Cmd + K)

### 3.2 Select Generic iOS Device
1. In the device selector (top toolbar), select **"Any iOS Device"** or **"Generic iOS Device"**
   - Don't select a simulator or connected device

### 3.3 Archive
1. **Product** → **Archive**
2. Wait for the build to complete (this may take a few minutes)
3. The **Organizer** window will open automatically

## Step 4: Upload to App Store Connect

### 4.1 Validate First (Recommended)
1. In the Organizer window, select your archive
2. Click **"Validate App"**
3. Fix any issues that come up
4. This checks for common problems before uploading

### 4.2 Distribute App
1. In the Organizer, select your archive
2. Click **"Distribute App"**
3. Select **"App Store Connect"**
4. Click **"Next"**
5. Select **"Upload"** (not Export)
6. Click **"Next"**
7. Review signing options (usually "Automatically manage signing")
8. Click **"Upload"**
9. Wait for upload to complete (can take 5-15 minutes)

## Step 5: Set Up TestFlight

### 5.1 Wait for Processing
- After upload, Apple processes your build (usually 10-30 minutes)
- You'll get an email when it's ready
- Check App Store Connect → TestFlight → Your Build

### 5.2 Add Test Information
1. Go to **App Store Connect** → **TestFlight**
2. Select your app → **iOS Builds**
3. Click on your build
4. Fill in **"What to Test"** (optional but recommended):
   ```
   This build includes:
   - Voice-powered meeting preparation briefings
   - Calendar integration
   - Meeting reminders and notifications
   - Multi-account support
   
   Please test:
   - Voice prep mode functionality
   - Notification delivery
   - Calendar sync
   ```

### 5.3 Add Internal Testers (Optional)
1. Go to **TestFlight** → **Internal Testing**
2. Add internal testers (up to 100)
3. They'll get immediate access once the build is processed

### 5.4 Add External Testers
1. Go to **TestFlight** → **External Testing**
2. Create a new group (e.g., "Beta Testers")
3. Add the build to the group
4. Add testers by email (up to 10,000)
5. Submit for Beta App Review (required for external testers)
   - This usually takes 24-48 hours
   - Apple reviews the app for basic compliance

## Step 6: Testers Install the App

### 6.1 Testers Need
- iOS device (iPhone/iPad)
- TestFlight app installed (free from App Store)
- Email invitation from Apple

### 6.2 Installation Process
1. Tester receives email invitation
2. Opens email on iOS device
3. Taps **"View in TestFlight"**
4. Installs TestFlight app (if not already installed)
5. Taps **"Accept"** → **"Install"**
6. App installs like a regular app

## Step 7: Update Builds (For Future Updates)

When you want to push an update:

1. **Increment Build Number** in Xcode:
   - Version can stay the same (e.g., `1.0.0`)
   - Build must increment (e.g., `1` → `2` → `3`)

2. **Build and Archive** again (repeat Step 3)

3. **Upload** to App Store Connect (repeat Step 4)

4. **Add to TestFlight** groups (repeat Step 5.4)

## Common Issues & Solutions

### Issue: "No accounts with App Store Connect access"
**Solution**: Make sure you're signed in to Xcode with your Apple Developer account:
- Xcode → Preferences → Accounts → Add your Apple ID

### Issue: "Bundle identifier already exists"
**Solution**: The bundle ID `com.kordn8.shadow` is already registered. Either:
- Use a different bundle ID (e.g., `com.yourcompany.shadow` or `io.shadow.app`)
- Or use the existing app record in App Store Connect
- **Note**: Bundle IDs are unique across all Apple Developer accounts

### Issue: "Invalid Bundle"
**Solution**: 
- Make sure you're archiving with "Any iOS Device" selected
- Clean build folder and try again
- Check that all required capabilities are configured

### Issue: "Missing Compliance"
**Solution**: 
- Go to App Store Connect → App Privacy
- Answer the privacy questions
- For most apps, you'll need to declare:
  - Data collection (if any)
  - Third-party SDKs
  - Advertising (if applicable)

### Issue: Build Processing Takes Too Long
**Solution**: 
- This is normal, can take up to 2 hours
- Check App Store Connect for status
- You'll get an email when ready

## Quick Checklist

- [ ] Apple Developer Account active ($99/year)
- [ ] Xcode installed and signed in
- [ ] Bundle ID set to `com.kordn8.shadow`
- [ ] Version and Build number set
- [ ] Signing configured with your team
- [ ] App created in App Store Connect
- [ ] Archive created successfully
- [ ] Build uploaded to App Store Connect
- [ ] Build processed (check email)
- [ ] TestFlight groups configured
- [ ] Testers invited

## Additional Resources

- [App Store Connect Help](https://help.apple.com/app-store-connect/)
- [TestFlight Documentation](https://developer.apple.com/testflight/)
- [Capacitor iOS Deployment](https://capacitorjs.com/docs/ios/deploying)

## Notes

- **TestFlight builds expire** after 90 days
- **External testing** requires Beta App Review (24-48 hours)
- **Internal testing** is immediate (no review needed)
- You can have **multiple builds** in TestFlight
- Testers can install **multiple versions** and switch between them

Good luck with your TestFlight release! 🚀

