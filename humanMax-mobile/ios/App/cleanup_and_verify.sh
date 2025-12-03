#!/bin/bash

# Cleanup and Verification Script for Swift Migration
set -e

echo "🧹 Cleaning up project..."
cd "$(dirname "$0")"

# Remove DerivedData
echo "📦 Cleaning DerivedData..."
rm -rf ~/Library/Developer/Xcode/DerivedData/App-* 2>/dev/null || true

# Verify all Swift files exist
echo ""
echo "✅ Verifying Swift files..."

REQUIRED_FILES=(
    "App/App.swift"
    "App/AppDelegate.swift"
    "App/Models/APIModels.swift"
    "App/Models/AuthModels.swift"
    "App/Services/APIClient.swift"
    "App/Services/AudioService.swift"
    "App/Services/AuthService.swift"
    "App/Services/BackgroundSyncService.swift"
    "App/Services/CacheService.swift"
    "App/Services/KeychainService.swift"
    "App/Services/NotificationService.swift"
    "App/Services/RealtimeService.swift"
    "App/Services/VoiceService.swift"
    "App/ViewModels/AuthViewModel.swift"
    "App/ViewModels/ChatViewModel.swift"
    "App/ViewModels/MeetingsViewModel.swift"
    "App/Views/AuthView.swift"
    "App/Views/CalendarView.swift"
    "App/Views/ChatView.swift"
    "App/Views/DayPrepView.swift"
    "App/Views/MeetingListView.swift"
    "App/Views/MeetingPrepView.swift"
    "App/Views/SettingsView.swift"
    "App/Views/VoicePrepView.swift"
    "App/Utilities/Constants.swift"
)

MISSING_FILES=()
for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        MISSING_FILES+=("$file")
        echo "❌ Missing: $file"
    fi
done

if [ ${#MISSING_FILES[@]} -eq 0 ]; then
    echo "✅ All required Swift files exist!"
else
    echo "⚠️  Missing ${#MISSING_FILES[@]} files"
fi

# Check for Capacitor references in Swift files
echo ""
echo "🔍 Checking for Capacitor references in Swift code..."
CAPACITOR_REFS=$(grep -r "import Capacitor\|Capacitor\." App/ --include="*.swift" 2>/dev/null | wc -l || echo "0")
if [ "$CAPACITOR_REFS" -eq 0 ]; then
    echo "✅ No Capacitor references found in Swift code"
else
    echo "⚠️  Found $CAPACITOR_REFS Capacitor references"
    grep -r "import Capacitor\|Capacitor\." App/ --include="*.swift" 2>/dev/null || true
fi

# Verify Podfile
echo ""
echo "📋 Checking Podfile..."
if grep -q "Capacitor" Podfile 2>/dev/null; then
    echo "⚠️  Podfile still contains Capacitor references"
else
    echo "✅ Podfile is clean"
fi

# Check if pod install needed
echo ""
if [ ! -f "Podfile.lock" ] || [ ! -d "Pods" ]; then
    echo "📦 Podfile.lock or Pods directory missing"
    if command -v pod &> /dev/null; then
        echo "Running pod install..."
        pod install
    else
        echo "⚠️  CocoaPods not installed. Install with: sudo gem install cocoapods"
        echo "   Then run: pod install"
    fi
else
    echo "✅ Pods directory exists"
fi

# Count Swift files
SWIFT_COUNT=$(find App/ -name "*.swift" -type f | wc -l | tr -d ' ')
echo ""
echo "📊 Found $SWIFT_COUNT Swift files"

echo ""
echo "✅ Cleanup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Open Xcode: open App.xcworkspace"
echo "2. Verify App.swift is added to target:"
echo "   - Select App.swift → File Inspector → Target Membership → Check 'App'"
echo "3. Verify all Swift files are added to target"
echo "4. Clean build folder: Shift+Cmd+K"
echo "5. Build: Cmd+B"
echo "6. Run: Cmd+R"

