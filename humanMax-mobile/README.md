# HumanMax Mobile - iOS App

Capacitor-based iOS app for HumanMax meeting preparation.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required variables:
- `VITE_GOOGLE_CLIENT_ID` - Your Google OAuth Client ID
- `VITE_API_URL` - Backend API URL (default: http://localhost:8080)

### 3. Build the Web App

```bash
npm run build
```

### 4. Sync with Capacitor

```bash
npx cap sync
```

### 5. Open in Xcode

```bash
npx cap open ios
```

## iOS Configuration

### Push Notifications Setup

1. Open the iOS project in Xcode
2. Select the project in the navigator
3. Go to "Signing & Capabilities"
4. Click "+ Capability" and add "Push Notifications"
5. Configure your App ID in Apple Developer Portal with Push Notifications enabled
6. Generate APNs key/certificate in Apple Developer Portal
7. Upload APNs key to your backend server (if using server-side push notifications)

### Bundle ID and Signing

1. In Xcode, select your project
2. Go to "Signing & Capabilities"
3. Set your Team and Bundle Identifier
4. Ensure "Automatically manage signing" is checked

### Info.plist Configuration

The Capacitor iOS project includes necessary configurations. Ensure:
- `NSAppTransportSecurity` allows HTTP in development (already configured)
- Push notification permissions are requested

## Development

### Run Web App (Development)

```bash
npm run dev
```

### Sync Changes to iOS

After making changes:

```bash
npm run build
npx cap sync
```

### Run on iOS Simulator

```bash
npx cap run ios
```

Or open in Xcode and run from there.

## Project Structure

```
src/
├── components/       # React components
│   ├── AuthView.tsx
│   ├── CalendarView.tsx
│   ├── MeetingList.tsx
│   ├── MeetingPrep.tsx
│   ├── DayPrep.tsx
│   └── Settings.tsx
├── services/         # Business logic
│   ├── apiClient.ts
│   ├── authService.ts
│   ├── notificationService.ts
│   └── backgroundSync.ts
├── types/            # TypeScript types
│   └── index.ts
└── App.tsx           # Main app component
```

## Features

- ✅ Google OAuth authentication
- ✅ Multi-account support
- ✅ Calendar view with day navigation
- ✅ Meeting details and prep briefs
- ✅ Day prep generation
- ✅ Push notifications (requires iOS configuration)
- ✅ Background sync
- ✅ Offline data caching

## Building for Production

1. Update `capacitor.config.ts` with production API URL
2. Build the web app: `npm run build`
3. Sync with Capacitor: `npx cap sync`
4. Open in Xcode: `npx cap open ios`
5. Archive and upload to App Store Connect

## Troubleshooting

### CORS Issues

Ensure your backend CORS configuration allows Capacitor origins (`capacitor://`, `ionic://`, `localhost`).

### Push Notifications Not Working

1. Verify Push Notifications capability is added in Xcode
2. Check APNs configuration in Apple Developer Portal
3. Ensure device token is being registered
4. Test on physical device (simulator doesn't support push notifications)

### Session Cookies Not Working

Ensure `withCredentials: true` is set in API client (already configured).

## Notes

- Widgets are not implemented yet (requires native Swift code)
- Push notifications require physical iOS device for testing
- Background sync works when app comes to foreground
