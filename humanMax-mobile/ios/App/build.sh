#!/bin/bash

# Swift iOS Build Script
# Equivalent to "cap sync" but much simpler - just opens Xcode!

set -e

echo "🚀 Swift iOS Build Script"
echo "========================="
echo ""

# Navigate to project directory
cd "$(dirname "$0")"

# Check if pod install is needed
if [ ! -d "Pods" ] || [ ! -f "Podfile.lock" ]; then
    echo "📦 Running pod install..."
    if command -v pod &> /dev/null; then
        pod install
    else
        echo "⚠️  CocoaPods not found. Install with: sudo gem install cocoapods"
        echo "   Or skip this step if you don't need pods."
    fi
    echo ""
fi

# Open Xcode workspace
echo "🔨 Opening Xcode workspace..."
open App.xcworkspace

echo ""
echo "✅ Xcode is opening!"
echo ""
echo "📋 Next steps in Xcode:"
echo "   1. Build: Cmd+B"
echo "   2. Run: Cmd+R"
echo ""
echo "💡 Tip: Use SwiftUI Live Preview for instant feedback!"
echo "   - Open any View file"
echo "   - Click 'Resume' in preview pane"
echo "   - Edit code and see changes instantly!"
echo ""

