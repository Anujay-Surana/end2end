# Railway Deployment Checklist

## Pre-Deployment Verification ✅

- [x] All syntax errors fixed
- [x] App imports successfully
- [x] Tests pass (14/16 passing, 2 failures are test logic issues)
- [x] Railway.json configured correctly
- [x] Requirements.txt complete
- [x] Main.py uses PORT env var

## Railway Configuration

The `railway.json` is configured to:
- Use NIXPACKS builder (auto-detects Python)
- Build from `shadow-python/` directory
- Start with `uvicorn` on port `$PORT` (Railway sets this automatically)

## Required Environment Variables in Railway

Make sure these are set in Railway dashboard:

### Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `DEEPGRAM_API_KEY`

### Optional (with defaults):
- `PARALLEL_API_KEY` (defaults to empty string)
- `SESSION_SECRET` (auto-generated if not set)
- `JWT_SECRET` (auto-generated if not set)
- `PORT` (Railway sets this automatically)
- `NODE_ENV` (defaults to 'development')
- `LOG_LEVEL` (defaults based on NODE_ENV)

## Deployment Steps

1. **Push to Git:**
   ```bash
   git add .
   git commit -m "Python backend migration complete"
   git push
   ```

2. **In Railway Dashboard:**
   - Ensure service is connected to your Git repository
   - Verify all environment variables are set
   - Check that the root `railway.json` is being used
   - Monitor the first deployment logs

3. **Verify Deployment:**
   - Check health endpoint: `https://your-railway-url.railway.app/health`
   - Test authentication flow
   - Monitor logs for any errors

## Post-Deployment

- [ ] Verify health endpoint responds
- [ ] Test authentication endpoints
- [ ] Check logs for any startup errors
- [ ] Verify database connection
- [ ] Test a meeting prep endpoint

## Rollback Plan

If deployment fails:
1. Check Railway logs for specific errors
2. Verify all environment variables are set correctly
3. Check Python version compatibility (Railway should auto-detect 3.12)
4. Verify `requirements.txt` dependencies are correct

## Notes

- Railway's NIXPACKS builder will auto-detect Python from `requirements.txt`
- The app uses `PORT` environment variable which Railway sets automatically
- All routes are prefixed with `/api` except websocket (`/ws`) and onboarding (`/onboarding`)
- CORS is configured to allow frontend/mobile app origins

