# Next Steps - Complete the Migration

## Step 1: Open Xcode ✅

```bash
cd /Users/anujaysurana/Desktop/End2End_Shadow/humanMax-mobile/ios/App
open App.xcworkspace
```

**Wait for Xcode to fully load** (you'll see the project in the left sidebar)

## Step 2: Add New Swift Files to Project

The new Swift files exist on disk but need to be added to the Xcode project:

### Add App.swift
1. In Xcode's Project Navigator (left sidebar), right-click on the **"App"** folder (blue icon)
2. Select **"Add Files to App..."**
3. Navigate to and select: `App/App.swift`
4. Make sure **"Copy items if needed"** is **UNCHECKED** (file already exists)
5. Make sure **"App"** target is **CHECKED**
6. Click **"Add"**

### Add Views Folder
1. Right-click on **"App"** folder again
2. Select **"Add Files to App..."**
3. Navigate to `App/Views/` folder
4. Select **ALL** Swift files in Views folder:
   - AuthView.swift
   - CalendarView.swift
   - ChatView.swift
   - DayPrepView.swift
   - MeetingListView.swift
   - MeetingPrepView.swift
   - SettingsView.swift
   - VoicePrepView.swift
5. Make sure **"Copy items if needed"** is **UNCHECKED**
6. Make sure **"App"** target is **CHECKED**
7. Click **"Add"**

### Add ViewModels Folder
1. Right-click on **"App"** folder again
2. Select **"Add Files to App..."**
3. Navigate to `App/ViewModels/` folder
4. Select **ALL** Swift files:
   - AuthViewModel.swift
   - ChatViewModel.swift
   - MeetingsViewModel.swift
5. Make sure **"Copy items if needed"** is **UNCHECKED**
6. Make sure **"App"** target is **CHECKED**
7. Click **"Add"**

## Step 3: Remove Old File References

Some files were moved to backup and will show in **red** (missing):

1. Find these files in Project Navigator (they'll be red):
   - `capacitor.config.json`
   - `config.xml`
   - `OpenAIRealtimePlugin.m`
   - `OpenAIRealtimePlugin.swift`
   - `public/` folder

2. For each red file:
   - Right-click → **"Delete"**
   - Choose **"Remove Reference"** (NOT "Move to Trash")

## Step 4: Run Pod Install (if needed)

If you see errors about missing pods:

```bash
cd /Users/anujaysurana/Desktop/End2End_Shadow/humanMax-mobile/ios/App
pod install
```

Then close and reopen Xcode workspace.

## Step 5: Clean and Build

In Xcode:
1. **Clean Build Folder**: `Shift + Cmd + K`
2. **Build**: `Cmd + B`
3. Fix any build errors (see troubleshooting below)

## Step 6: Run the App

1. Select a simulator from the device menu (top toolbar)
2. Press `Cmd + R` to run
3. App should launch!

## Common Build Errors & Fixes

### Error: "Cannot find 'App' in scope"
- **Fix**: Make sure `App.swift` is added to project (Step 2)

### Error: "Cannot find type 'AuthViewModel'"
- **Fix**: Make sure ViewModels folder is added (Step 2)

### Error: "Cannot find type 'AuthView'"
- **Fix**: Make sure Views folder is added (Step 2)

### Error: Red file references
- **Fix**: Remove references to moved files (Step 3)

### Error: "Missing required module 'Capacitor'"
- **Fix**: Check AppDelegate.swift - should NOT have `import Capacitor`
- If it does, remove that line

### Error: "No such module 'Capacitor'"
- **Fix**: Clean build folder (`Shift + Cmd + K`) and rebuild

## Verification Checklist

After building successfully, verify:

- [ ] Project builds without errors (`Cmd + B`)
- [ ] App launches on simulator (`Cmd + R`)
- [ ] AuthView appears (sign-in screen)
- [ ] No Capacitor-related errors in console
- [ ] All Swift files visible in Project Navigator

## What You Should See

### On First Launch:
- **AuthView** with "Sign in with Google" button
- Clean, native iOS interface

### After Sign-In:
- **Main Tab View** with three tabs:
  - Calendar (meetings)
  - Chat (messages)
  - Settings (account management)

## If You Get Stuck

1. **Check console logs** in Xcode (bottom panel)
2. **Read error messages** carefully
3. **Verify file membership**: Select a Swift file → File Inspector (right sidebar) → Check "Target Membership" → Ensure "App" is checked
4. **Clean build folder** and try again

## Quick Reference

```bash
# Open Xcode
cd /Users/anujaysurana/Desktop/End2End_Shadow/humanMax-mobile/ios/App
open App.xcworkspace

# Or use the script
./build.sh
```

**In Xcode:**
- Build: `Cmd + B`
- Run: `Cmd + R`
- Clean: `Shift + Cmd + K`

## You're Almost There! 🚀

The hard part (code migration) is done. Now it's just:
1. Add files to Xcode project
2. Build
3. Run
4. Test!

Good luck! 🎉
