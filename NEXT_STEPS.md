# Next Steps After Migrations

## ✅ Completed
- Database migrations (all tables created)
- Backend services implemented
- Mobile app components created
- Scheduler service integrated

## 🔧 Configuration Required

### 1. Install Python Dependencies
```bash
cd shadow-python
pip install -r requirements.txt
```

This will install:
- `apscheduler>=3.10.0` - For scheduled tasks
- `PyAPNs2>=0.7.2` - For push notifications

### 2. Configure Environment Variables

Add these to your `.env` file (in project root):

```bash
# APNs Configuration (Required for push notifications)
APNS_KEY_ID=your_key_id_here          # From Apple Developer Portal
APNS_TEAM_ID=your_team_id_here        # Your Apple Team ID
APNS_BUNDLE_ID=com.kordn8.shadow      # Your iOS app bundle ID
APNS_KEY_PATH=/path/to/AuthKey.p8     # Path to APNs key file
# OR use APNS_KEY_CONTENT instead (base64 or raw key content)
APNS_USE_SANDBOX=true                 # true for development, false for production
```

**To get APNs credentials:**
1. Go to [Apple Developer Portal](https://developer.apple.com/account/)
2. Navigate to "Keys" → Create new key
3. Enable "Apple Push Notifications service (APNs)"
4. Download the `.p8` key file
5. Note the Key ID and Team ID

### 3. Update User Timezones

Users need timezone information for scheduled tasks. You can:

**Option A: Set default timezone for existing users**
```sql
UPDATE users SET timezone = 'America/New_York' WHERE timezone = 'UTC';
```

**Option B: Update during OAuth flow**
Modify the auth flow to detect and store user timezone from their device.

### 4. Test Backend Services

#### Start the backend:
```bash
cd shadow-python
./venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

#### Verify scheduler started:
Check logs for: `"Scheduler service started"`

#### Test device registration:
```bash
curl -X POST http://localhost:8080/api/devices/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN" \
  -d '{
    "device_token": "test_token",
    "platform": "ios",
    "timezone": "America/New_York"
  }'
```

### 5. Build and Test Mobile App

#### Build the web app:
```bash
cd humanMax-mobile
npm install
npm run build
```

#### Sync with Capacitor:
```bash
npx cap sync ios
```

#### Open in Xcode:
```bash
npx cap open ios
```

#### Configure iOS:
1. In Xcode, ensure Push Notifications capability is enabled
2. Set your Team and Bundle ID
3. Build and run on a physical device (push notifications don't work on simulator)

### 6. Test Push Notifications

#### On device:
1. Launch the app
2. Sign in with Google
3. Grant push notification permissions
4. Check backend logs - you should see device registration

#### Send test notification:
You can manually trigger a daily summary or meeting reminder by calling the scheduler functions directly, or wait for the scheduled times.

### 7. Test Scheduled Tasks

The scheduler runs:
- **Every hour** - Checks for users at midnight (local time) to generate briefs
- **Every hour** - Checks for users at 9 AM (local time) to send daily summaries  
- **Every minute** - Checks for meetings starting in 15 minutes

**To test immediately:**
You can manually call the functions in Python:
```python
from app.services.midnight_brief_generator import generate_briefs_for_user
from app.services.daily_summary import send_daily_summary_for_user

# Generate briefs for a user
await generate_briefs_for_user('user_id_here')

# Send daily summary
await send_daily_summary_for_user('user_id_here')
```

### 8. Complete OpenAI Realtime Plugin (Optional)

The plugin structure is created but needs:
1. WebSocket connection to OpenAI Realtime API
2. Audio playback implementation
3. Proper error handling

This can be done later if voice features aren't critical for MVP.

## 🐛 Troubleshooting

### Scheduler not running?
- Check logs for errors during startup
- Verify APScheduler is installed: `pip list | grep apscheduler`
- Check timezone handling - ensure users have valid timezones

### Push notifications not working?
- Verify APNs credentials are correct
- Check device token is registered in database
- Ensure app has Push Notifications capability enabled
- Test with sandbox first (`APNS_USE_SANDBOX=true`)

### Database errors?
- Verify Supabase connection
- Check all migrations ran successfully
- Verify service role key has proper permissions

## 📝 Testing Checklist

- [ ] Backend starts without errors
- [ ] Scheduler service initializes
- [ ] Device registration endpoint works
- [ ] Mobile app builds and runs
- [ ] Push notification permission requested
- [ ] Device token registered in database
- [ ] Chat messages save and load
- [ ] Meeting modal opens from notification
- [ ] Daily summary sends at 9 AM (test manually)
- [ ] Meeting reminders send 15 min before (test manually)

## 🚀 Production Deployment

Before deploying:
1. Set `APNS_USE_SANDBOX=false`
2. Use production APNs key
3. Verify all environment variables are set
4. Test on TestFlight first
5. Monitor scheduler logs
6. Set up error alerting for failed notifications

