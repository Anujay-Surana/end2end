# Redirect URI Verification

## Two Redirect URIs in OAuth Flow

### 1. Google OAuth Redirect URI (What Google redirects to)
**This must match EXACTLY what's in Google Cloud Console**

**Backend sends to Google:**
```
https://end2end-production.up.railway.app/auth/google/mobile-callback
```

**Frontend builds:**
```typescript
const redirectUri = `${API_URL}/auth/google/mobile-callback`;
// Where API_URL = 'https://end2end-production.up.railway.app'
// Result: https://end2end-production.up.railway.app/auth/google/mobile-callback
```

**✅ These match!**

### 2. Deep Link URL (What opens the app)
**This must match the URL scheme in Info.plist**

**Backend creates:**
```
com.kordn8.shadow://auth/callback?code=...&state=...
```

**Info.plist has:**
```xml
<key>CFBundleURLSchemes</key>
<array>
    <string>com.kordn8.shadow</string>
</array>
```

**✅ This matches!**

## Verification Steps

### Step 1: Check Google Cloud Console
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to: **APIs & Services** → **Credentials**
3. Click on your **OAuth 2.0 Client ID** (the one used for mobile)
4. Check **"Authorized redirect URIs"**
5. **MUST have exactly:**
   ```
   https://end2end-production.up.railway.app/auth/google/mobile-callback
   ```
6. **Important:** 
   - Must be HTTPS (not HTTP)
   - Must match EXACTLY (no trailing slash, no typos)
   - Case-sensitive

### Step 2: Verify the Flow
1. User taps "Sign in" in app
2. App opens Safari with: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https://end2end-production.up.railway.app/auth/google/mobile-callback&...`
3. User authorizes
4. Google redirects to: `https://end2end-production.up.railway.app/auth/google/mobile-callback?code=...&state=...`
5. Backend receives code, creates deep link: `com.kordn8.shadow://auth/callback?code=...&state=...`
6. Safari should open the app with this deep link
7. App receives deep link via `appUrlOpen` listener

### Step 3: Common Issues

**Issue: "redirect_uri_mismatch" error**
- **Cause:** Redirect URI in Google Cloud Console doesn't match
- **Fix:** Add `https://end2end-production.up.railway.app/auth/google/mobile-callback` to Authorized redirect URIs

**Issue: Deep link doesn't open app**
- **Cause:** URL scheme not registered or app not installed
- **Fix:** Rebuild and reinstall app after bundle ID change

**Issue: App receives deep link but doesn't process it**
- **Cause:** URL matching logic too strict
- **Fix:** Check console logs for URL matching details

## Current Configuration

**Backend (routes/auth.js):**
- Line 51: `redirectUri = 'https://end2end-production.up.railway.app/auth/google/mobile-callback'`
- Line 316: `redirectUrl = 'com.kordn8.shadow://auth/callback?code=...'`

**Frontend (authService.ts):**
- Line 381: `redirectUri = '${API_URL}/auth/google/mobile-callback'`
- Where `API_URL = 'https://end2end-production.up.railway.app'`

**Info.plist:**
- URL Scheme: `com.kordn8.shadow`

## Test Commands

Test if redirect URI is registered:
```bash
# This should work if redirect URI is correct
curl "https://accounts.google.com/o/oauth2/v2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=https://end2end-production.up.railway.app/auth/google/mobile-callback&response_type=code&scope=openid"
```

Test deep link:
- In Safari: `com.kordn8.shadow://test` (should open app)
- In Safari: `com.kordn8.shadow://auth/callback?code=test123` (should trigger listener)

