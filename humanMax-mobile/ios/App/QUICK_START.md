# Quick Start - Open Xcode

## Correct Path

The Xcode workspace is located at:
```
humanMax-mobile/ios/App/App.xcworkspace
```

## Open Xcode (Choose One Method)

### Method 1: From Terminal
```bash
cd /Users/anujaysurana/Desktop/End2End_Shadow/humanMax-mobile/ios/App
open App.xcworkspace
```

### Method 2: Use the Build Script
```bash
cd /Users/anujaysurana/Desktop/End2End_Shadow/humanMax-mobile/ios/App
./build.sh
```

### Method 3: From Finder
1. Navigate to: `humanMax-mobile/ios/App/`
2. Double-click `App.xcworkspace`

## Important Notes

⚠️ **Always open `App.xcworkspace`, NOT `App.xcodeproj`**

The workspace includes CocoaPods configuration. Opening the project file directly won't work correctly.

## After Opening

1. Wait for Xcode to index files
2. Select a simulator or device
3. Press `Cmd+B` to build
4. Press `Cmd+R` to run

## Troubleshooting

**Error: "The file does not exist"**
- Make sure you're in the `ios/App/` directory
- Check: `ls -la App.xcworkspace`

**Error: "No such file or directory"**
- Navigate to: `cd /Users/anujaysurana/Desktop/End2End_Shadow/humanMax-mobile/ios/App`
- Then try: `open App.xcworkspace`

