# Google OAuth Redirect URI Setup

## The Problem

Your app uses this redirect URI:
```
https://end2end-production.up.railway.app/auth/google/mobile-callback
```

For iOS apps using `ASWebAuthenticationSession`, you need a **Web application** OAuth client (not an iOS client) because the redirect goes to your backend server first.

## Solution: Create a Web Application OAuth Client

### Step 1: Go to Google Cloud Console

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project
3. Navigate to **APIs & Services** → **Credentials**

### Step 2: Create Web Application Client

1. Click **"+ CREATE CREDENTIALS"** → **"OAuth client ID"**
2. **Application type:** Select **"Web application"** (NOT iOS)
3. **Name:** Give it a name like "Shadow iOS Web Client"
4. Click **"CREATE"**

### Step 3: Add Authorized Redirect URI

After creating the Web client:

1. You'll see a popup with your Client ID - **copy this Client ID**
2. In the credentials list, click on your newly created **Web application** client
3. Under **"Authorized redirect URIs"**, click **"+ ADD URI"**
4. Add exactly this URI (copy-paste to avoid typos):
   ```
   https://end2end-production.up.railway.app/auth/google/mobile-callback
   ```
5. Click **"SAVE"**

### Step 4: Update Your App

Replace the iOS Client ID in `Info.plist` with the **Web application** Client ID you just created.

## Why Web Application?

Your iOS app uses `ASWebAuthenticationSession`, which:
1. Opens a web browser
2. Redirects to your backend server (`https://end2end-production.up.railway.app/auth/google/mobile-callback`)
3. Your backend then redirects to the app via deep link (`com.kordn8.shadow://`)

This requires a **Web application** OAuth client because the redirect URI is an HTTPS URL, not an iOS URL scheme.

## Current Redirect URI

Your app is configured to use:
- **Redirect URI:** `https://end2end-production.up.railway.app/auth/google/mobile-callback`
- **Deep Link Scheme:** `com.kordn8.shadow://` (already configured in Info.plist)

## Quick Checklist

- [ ] Created **Web application** OAuth client (not iOS)
- [ ] Added redirect URI: `https://end2end-production.up.railway.app/auth/google/mobile-callback`
- [ ] Copied the Web application Client ID
- [ ] Updated `Info.plist` with the Web application Client ID
- [ ] Rebuilt and tested the app

## After Setup

1. Update `Info.plist` with the new Web application Client ID
2. Rebuild the app (`Cmd + B`)
3. Run the app (`Cmd + R`)
4. Try signing in - the redirect URI mismatch error should be gone!

