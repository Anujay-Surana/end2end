#!/bin/bash

# Quick script to open Xcode project after migration

echo "🚀 Opening Xcode workspace..."
cd "$(dirname "$0")"
open App.xcworkspace

echo ""
echo "✅ Xcode should be opening now!"
echo ""
echo "📋 Next steps:"
echo "1. Add new Swift files to project (if not already added):"
echo "   - App.swift"
echo "   - Views/ folder (all Swift files)"
echo "   - ViewModels/ folder (all Swift files)"
echo ""
echo "2. Remove old file references (if they show in red):"
echo "   - capacitor.config.json"
echo "   - config.xml"
echo "   - OpenAIRealtimePlugin files"
echo "   - public/ folder"
echo ""
echo "3. Run pod install (if not done):"
echo "   pod install"
echo ""
echo "4. Clean build folder: Shift+Cmd+K"
echo ""
echo "5. Build: Cmd+B"
echo ""
echo "6. Run: Cmd+R"
echo ""
echo "📖 See XCODE_TESTING_GUIDE.md for detailed instructions"

