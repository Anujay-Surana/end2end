# Xcode Testing Guide - Swift Migration

## Step-by-Step Instructions

### 1. Open the Project in Xcode

```bash
cd /Users/anujaysurana/Desktop/End2End_Shadow/humanMax-mobile/ios/App
open App.xcworkspace
```

**Important:** Always open `App.xcworkspace`, NOT `App.xcodeproj`. The workspace includes CocoaPods configuration.

### 2. Add New Swift Files to Xcode Project

The new Swift files need to be added to the Xcode project:

#### Add App.swift
1. In Xcode, right-click on the `App` folder in the Project Navigator (left sidebar)
2. Select "Add Files to App..."
3. Navigate to `App/App.swift`
4. Check "Copy items if needed" (unchecked is fine)
5. Ensure "App" target is checked
6. Click "Add"

#### Add Views Folder
1. Right-click on the `App` folder
2. Select "Add Files to App..."
3. Navigate to `App/Views/` folder
4. Select all Swift files in Views folder
5. Ensure "App" target is checked
6. Click "Add"

#### Add ViewModels Folder
1. Right-click on the `App` folder
2. Select "Add Files to App..."
3. Navigate to `App/ViewModels/` folder
4. Select all Swift files in ViewModels folder
5. Ensure "App" target is checked
6. Click "Add"

### 3. Remove Old File References

Remove references to files that were moved to backup:

1. In Project Navigator, find these files (they'll show in red if missing):
   - `capacitor.config.json`
   - `config.xml`
   - `OpenAIRealtimePlugin.m`
   - `OpenAIRealtimePlugin.swift`
   - `public/` folder

2. Right-click each and select "Delete"
3. Choose "Remove Reference" (not "Move to Trash")

### 4. Update Project Settings

#### Set App.swift as Entry Point
1. Select the project in Project Navigator (top item)
2. Select the "App" target
3. Go to "Build Settings" tab
4. Search for "Swift Compiler - General"
5. Ensure "Swift Language Version" is set to Swift 5

#### Verify Info.plist
1. Select the project
2. Select "App" target
3. Go to "Info" tab
4. Verify "Main storyboard file base name" is empty (should be removed)
5. Verify "Launch screen interface file base name" is "LaunchScreen"

### 5. Run Pod Install

Open Terminal and run:

```bash
cd /Users/anujaysurana/Desktop/End2End_Shadow/humanMax-mobile/ios/App
pod install
```

This will regenerate the Pods directory without Capacitor dependencies.

### 6. Clean Build Folder

In Xcode:
1. Go to Product → Clean Build Folder (Shift+Cmd+K)
2. Wait for cleaning to complete

### 7. Build the Project

1. Select a simulator or device from the device menu (top toolbar)
2. Press Cmd+B to build
3. Fix any build errors:

#### Common Build Errors and Fixes:

**Error: "Cannot find 'App' in scope"**
- Make sure `App.swift` is added to the project and target

**Error: "Cannot find type 'AuthViewModel'"**
- Make sure all ViewModels are added to the project

**Error: "Cannot find type 'AuthView'"**
- Make sure all Views are added to the project

**Error: "Missing required module 'Capacitor'"**
- This means some file still imports Capacitor - check AppDelegate.swift
- Remove any Capacitor imports

**Error: "No such module 'Capacitor'"**
- Clean build folder and rebuild
- Make sure Podfile doesn't reference Capacitor

**Error: Red file references**
- Remove references to moved files (capacitor.config.json, etc.)

### 8. Run the App

1. Press Cmd+R to run
2. The app should launch on the simulator/device

### 9. Test Key Features

#### Test Authentication
1. App should show AuthView with "Sign in with Google" button
2. Tap the button
3. OAuth flow should open in Safari/WebView
4. After signing in, should redirect back to app
5. Should show main tab view

#### Test Navigation
1. Should see three tabs: Calendar, Chat, Settings
2. Tap between tabs - should navigate smoothly

#### Test Services
- Check console logs for service initialization
- Verify no Capacitor-related errors

### 10. Debugging Tips

#### Check Console Logs
- Look for any errors in Xcode console
- Check for "Capacitor" mentions (should be none)

#### Verify Services Initialize
Look for these log messages:
- NotificationService initialization
- BackgroundSyncService initialization

#### Check for Missing Files
If you see "file not found" errors:
1. Verify file exists in Finder
2. Check if file is added to Xcode project
3. Check if file is added to target membership

### 11. If Build Fails

#### Check Build Settings
1. Select project → App target → Build Settings
2. Search for "Swift Language Version" - should be Swift 5
3. Search for "iOS Deployment Target" - should be 14.0+

#### Check File Membership
1. Select a Swift file
2. In File Inspector (right sidebar), check "Target Membership"
3. Ensure "App" is checked

#### Check Compiler Errors
1. Read error messages carefully
2. Most common: missing imports or file references
3. Fix one error at a time

### 12. Verify Migration Success

Check these to confirm migration is complete:

- [ ] Project builds without errors
- [ ] No Capacitor imports in any Swift file
- [ ] App launches successfully
- [ ] AuthView appears when not signed in
- [ ] OAuth flow works
- [ ] Main tabs appear after sign-in
- [ ] No Capacitor-related errors in console

## Quick Reference Commands

```bash
# Navigate to project
cd /Users/anujaysurana/Desktop/End2End_Shadow/humanMax-mobile/ios/App

# Open in Xcode
open App.xcworkspace

# Run pod install
pod install

# Clean derived data (if needed)
rm -rf ~/Library/Developer/Xcode/DerivedData
```

## Troubleshooting

### "No such module" errors
- Clean build folder (Shift+Cmd+K)
- Delete DerivedData
- Run `pod install` again
- Rebuild

### Red file references
- Remove from project (right-click → Delete → Remove Reference)
- Or add files back if they're needed

### Build errors about missing types
- Ensure all Swift files are added to project
- Check target membership
- Clean and rebuild

### Pod install fails
- Make sure you're in the correct directory (`ios/App`)
- Check Podfile syntax
- Try `pod deintegrate` then `pod install`

## Next Steps After Successful Build

1. Test OAuth flow end-to-end
2. Test chat functionality
3. Test calendar/meetings
4. Test settings
5. Test voice recording (if implemented)
6. Test push notifications (if configured)

## Need Help?

If you encounter issues:
1. Check the error message in Xcode
2. Check console logs
3. Verify all files are added to project
4. Ensure pod install completed successfully
5. Clean build folder and rebuild

