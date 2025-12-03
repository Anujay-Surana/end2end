# Install CocoaPods

CocoaPods is required to generate the Podfile.lock and Pods configuration files.

## Installation Options

### Option 1: Install with sudo (Recommended)

```bash
sudo gem install cocoapods
```

You'll be prompted for your password.

### Option 2: Install without sudo (User-level)

```bash
gem install cocoapods --user-install
```

Then add to your PATH. Add this to your `~/.zshrc`:

```bash
export PATH="$HOME/.gem/ruby/2.6.0/bin:$PATH"
```

Then reload:
```bash
source ~/.zshrc
```

### Option 3: Install via Homebrew (if you have Homebrew)

```bash
brew install cocoapods
```

## After Installation

1. Verify installation:
```bash
pod --version
```

2. Run pod install:
```bash
cd /Users/anujaysurana/Desktop/End2End_Shadow/humanMax-mobile/ios/App
pod install
```

3. Reopen Xcode workspace:
```bash
open App.xcworkspace
```

4. Build in Xcode: `Cmd + B`

## Troubleshooting

**If you get permission errors:**
- Use `sudo gem install cocoapods`
- Or install to user directory with `--user-install`

**If pod command not found after installation:**
- Check your PATH: `echo $PATH`
- Add gem bin directory to PATH (see Option 2 above)

**If pod install fails:**
- Make sure you're in the `ios/App` directory
- Check Podfile syntax is correct
- Try: `pod deintegrate` then `pod install`

