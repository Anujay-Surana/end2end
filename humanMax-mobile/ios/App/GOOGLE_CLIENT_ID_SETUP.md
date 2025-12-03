# Google Client ID Setup

## Quick Setup

The Google OAuth Client ID needs to be configured for authentication to work. You have two options:

### Option 1: Add to Info.plist (Recommended for Development)

1. Open `App/Info.plist` in Xcode
2. Find the `GoogleClientID` key (or add it if missing)
3. Replace `YOUR_GOOGLE_CLIENT_ID_HERE.apps.googleusercontent.com` with your actual Google Client ID

### Option 2: Set Environment Variable

Set the `GOOGLE_CLIENT_ID` environment variable before running the app:

```bash
export GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
```

Or in Xcode:
1. Edit Scheme → Run → Arguments
2. Add Environment Variable: `GOOGLE_CLIENT_ID` = `your-client-id.apps.googleusercontent.com`

## Getting Your Google Client ID

If you don't have a Google Client ID yet:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google+ API
4. Go to "Credentials" → "Create Credentials" → "OAuth client ID"
5. Choose "iOS" as the application type
6. Enter your bundle identifier: `com.kordn8.shadow`
7. Copy the Client ID (it looks like: `123456789-abcdefghijklmnop.apps.googleusercontent.com`)

## Important Notes

- **For iOS apps**: You need an iOS OAuth client ID (not a Web client ID)
- **Redirect URI**: The app uses `com.kordn8.shadow://auth/google/mobile-callback`
- Make sure this redirect URI is configured in your Google Cloud Console OAuth client settings

## Current Configuration

The app checks for the Client ID in this order:
1. Environment variable `GOOGLE_CLIENT_ID`
2. Info.plist key `GoogleClientID`

If neither is found, authentication will fail with the error you're seeing.

## After Configuration

1. Rebuild the app (`Cmd + B`)
2. Run the app (`Cmd + R`)
3. Try signing in - the error should be gone!

