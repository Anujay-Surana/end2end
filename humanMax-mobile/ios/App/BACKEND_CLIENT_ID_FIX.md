# Backend Client ID Mismatch Fix

## The Problem

Your iOS app is using a **Web application** Client ID:
```
173246695918-vbpcthe7tuo0vhmft1d1poots6cd38l3.apps.googleusercontent.com
```

But your backend is using a **different** Client ID/Secret from environment variables. When Google issues an authorization code using the Web Client ID, the backend must use the **same** Client ID and its corresponding Secret to exchange it.

## The Solution

You need to update your backend's environment variables to use the **Web application** Client ID and Secret.

### Step 1: Get the Client Secret

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to **APIs & Services** → **Credentials**
3. Click on your **Web application** OAuth client (the one with Client ID ending in `...vbpcthe7tuo0vhmft1d1poots6cd38l3`)
4. Copy the **Client Secret** (it looks like: `GOCSPX-xxxxxxxxxxxxxxxxxxxxx`)

### Step 2: Update Backend Environment Variables

Update your backend's `.env` file or Railway environment variables:

```bash
GOOGLE_CLIENT_ID=173246695918-vbpcthe7tuo0vhmft1d1poots6cd38l3.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET_HERE
```

**Important:** Make sure you're using the **Web application** Client ID and Secret, not the iOS one.

### Step 3: Restart Backend

After updating the environment variables:
- If running locally: Restart your Python backend
- If on Railway: The app will automatically restart when you update environment variables

## Why This Happens

The OAuth flow requires:
1. **Authorization:** iOS app uses Client ID to get authorization code
2. **Token Exchange:** Backend uses **same** Client ID + Secret to exchange code for tokens

If the Client IDs don't match, Google rejects the token exchange with "Bad Request".

## Verification

After updating:
1. Try signing in again from the iOS app
2. Check Railway logs - you should see successful token exchange instead of "Bad Request"
3. The authentication should complete successfully

## Current Configuration

- **iOS App Client ID:** `173246695918-vbpcthe7tuo0vhmft1d1poots6cd38l3.apps.googleusercontent.com` (Web application)
- **Backend Client ID:** Check your `.env` file or Railway environment variables
- **Backend Client Secret:** Check your `.env` file or Railway environment variables

Make sure all three match the same Web application OAuth client!

