# Local Testing Setup for iPhone

When testing the iOS app on a physical iPhone, you need to configure it to connect to your local development server.

## Option 1: Use Environment Variable (Recommended)

1. Create a `.env` file in the `humanMax-mobile` directory:
   ```bash
   cd humanMax-mobile
   ```

2. Add your Mac's IP address:
   ```env
   VITE_API_URL=http://10.20.0.15:8080
   VITE_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
   ```

3. **Important**: Make sure your iPhone and Mac are on the same Wi-Fi network

4. Rebuild the app:
   ```bash
   npm run build
   npx cap sync
   ```

5. Open in Xcode and run on your device

## Option 2: Find Your Mac's IP Address

If your IP address changes, find it with:
```bash
ifconfig | grep "inet " | grep -v 127.0.0.1
```

Or use your Mac's hostname:
```env
VITE_API_URL=http://your-mac-name.local:8080
```

## Option 3: Use Railway Production URL

If you want to test against the production server:
```env
VITE_API_URL=https://end2end-production.up.railway.app
```

## Troubleshooting

### Network Error on iPhone

1. **Check Wi-Fi**: Ensure iPhone and Mac are on the same network
2. **Check Firewall**: Make sure your Mac's firewall allows connections on port 8080
3. **Check Server**: Verify your backend is running:
   ```bash
   curl http://localhost:8080/health
   ```
4. **Test from iPhone browser**: Try opening `http://10.20.0.15:8080/health` in Safari on your iPhone

### CORS Errors

Make sure your backend CORS configuration allows requests from Capacitor apps. The backend should already be configured to allow all origins in development.

### SSL/HTTPS Issues

If testing locally, use HTTP (not HTTPS) for your Mac's IP address. The Railway production URL uses HTTPS automatically.

