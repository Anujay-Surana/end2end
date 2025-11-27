# Fix iOS URL Scheme Cache Issue

## The Problem
iOS is saying "opening in humanmax app" instead of "Shadow app". This is because iOS has cached the old app association with the URL scheme.

## Solution: Clear iOS Cache

### Step 1: Delete the App Completely
1. On your iPhone, **long press** the Shadow app icon
2. Tap **"Remove App"**
3. Tap **"Delete App"** (not just "Remove from Home Screen")
4. Confirm deletion

### Step 2: Restart Your iPhone
1. Hold power button + volume down (or just power button on older iPhones)
2. Slide to power off
3. Wait 30 seconds
4. Power back on

**Why:** This clears iOS's URL scheme cache and app associations.

### Step 3: Clean Xcode Build
```bash
cd humanMax-mobile/ios/App
open App.xcworkspace
```

In Xcode:
1. **Product** → **Clean Build Folder** (Shift + Cmd + K)
2. Close Xcode

### Step 4: Rebuild and Reinstall
1. Open Xcode again
2. Select your device (not simulator)
3. **Product** → **Run** (Cmd + R)
4. Wait for app to install

### Step 5: Verify App Name
After reinstalling, check:
- App icon should say **"Shadow"** (not "HumanMax")
- Settings → General → iPhone Storage → Should show "Shadow"

### Step 6: Test Deep Link Again
1. Open Safari
2. Type: `com.kordn8.shadow://test`
3. Should say **"Open in Shadow?"** (not "HumanMax")

## Alternative: Reset All Settings (Nuclear Option)

If the above doesn't work:
1. Settings → General → Transfer or Reset iPhone
2. Reset → Reset Location & Privacy
3. This clears all app associations (but keeps your data)

## Why This Happens

iOS caches URL scheme associations for performance. When you:
- Change bundle ID
- Change app name
- Change URL scheme

iOS might still have the old association cached. Restarting the device clears this cache.

## Prevention

After making bundle ID/name changes:
1. Always delete old app
2. Restart device
3. Reinstall app

This ensures iOS recognizes the new associations.

