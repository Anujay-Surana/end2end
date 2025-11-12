# Deployment Guide - Railway.app

## Why Railway?
- No execution time limits (perfect for your AI meeting prep endpoint)
- Simplest deployment process (10-15 minutes)
- Lowest cost ($3-7/month for typical usage)
- Serves both backend API and frontend in one deployment
- Free $5 credits to start

---

## Prerequisites

1. A GitHub account (recommended for continuous deployment)
2. Your API keys ready:
   - Google Client ID & Secret
   - OpenAI API Key
   - Parallel AI API Key

---

## Step 1: Push to GitHub (Optional but Recommended)

If you haven't already:

```bash
cd /Users/anujaysurana/Desktop/humanMax
git init
git add .
git commit -m "Initial commit - Meeting prep app"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

---

## Step 2: Deploy to Railway

### 2.1 Sign Up for Railway

1. Go to https://railway.app
2. Click "Login" → "Login with GitHub"
3. Authorize Railway to access your GitHub account

### 2.2 Create New Project

1. Click "New Project"
2. Choose one of these options:
   - **Option A (Recommended):** "Deploy from GitHub repo" → Select your repository
   - **Option B:** "Empty Project" → Then add a service → "GitHub Repo"

3. Railway will automatically:
   - Detect it's a Node.js project
   - Run `npm install`
   - Start the server with `npm start`

### 2.3 Configure Environment Variables

1. Click on your deployed service
2. Go to the **"Variables"** tab
3. Click **"+ New Variable"**
4. Add all four environment variables:

```
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
OPENAI_API_KEY=your_openai_api_key_here
PARALLEL_API_KEY=your_parallel_api_key_here
```

**Important:** Use your actual API keys from the `.env` file (NOT checked into git)

5. Railway will automatically redeploy after adding variables

### 2.4 Generate Public Domain

1. In your service settings, go to **"Settings"** tab
2. Scroll to **"Networking"**
3. Click **"Generate Domain"**
4. You'll get a URL like: `https://humanmax-production.up.railway.app`

---

## Step 3: Update Google OAuth Settings

Your app is now live, but Google OAuth needs to know about the new domain.

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to: **APIs & Services** → **Credentials**
3. Click on your OAuth 2.0 Client ID
4. Under **"Authorized JavaScript origins"**, add:
   ```
   https://YOUR-APP-NAME.up.railway.app
   ```
5. Under **"Authorized redirect URIs"**, add:
   ```
   https://YOUR-APP-NAME.up.railway.app
   ```
6. Click **"Save"**

---

## Step 4: Test Your Deployment

1. Visit your Railway URL: `https://YOUR-APP-NAME.up.railway.app`
2. Click "Sign in with Google"
3. Authorize calendar/email/drive access
4. Navigate through your calendar
5. Click on a meeting and test "Prep Me" button

---

## Step 5: Monitor Your App

### View Logs
1. In Railway dashboard → Your service → **"Deployments"** tab
2. Click on the latest deployment → **"View Logs"**
3. You'll see real-time console output

### Check Metrics
1. Go to **"Metrics"** tab
2. View:
   - CPU usage
   - Memory usage
   - Network traffic

---

## Cost Estimate

Railway pricing is based on usage:

- **Free tier:** $5 in credits per month
- **After free credits:** ~$0.50-2.00/day for moderate use
- **Estimated monthly cost:** $3-7 for typical usage

To monitor costs:
1. Go to Railway dashboard → **"Usage"**
2. See real-time cost breakdown

---

## Continuous Deployment

Once connected to GitHub, every push to `main` branch will:
1. Automatically trigger a new deployment
2. Run tests (if configured)
3. Deploy if successful
4. Keep previous version running until new one is ready

---

## Alternative: Deploy Without GitHub

If you prefer not to use GitHub:

1. Install Railway CLI:
   ```bash
   npm i -g @railway/cli
   ```

2. Login:
   ```bash
   railway login
   ```

3. Initialize and deploy:
   ```bash
   cd /Users/anujaysurana/Desktop/humanMax
   railway init
   railway up
   ```

4. Set environment variables:
   ```bash
   railway variables set GOOGLE_CLIENT_ID=your_value
   railway variables set GOOGLE_CLIENT_SECRET=your_value
   railway variables set OPENAI_API_KEY=your_value
   railway variables set PARALLEL_API_KEY=your_value
   ```

---

## Troubleshooting

### App Won't Start
- Check logs in Railway dashboard
- Verify all 4 environment variables are set
- Ensure `npm start` works locally

### Google OAuth Not Working
- Verify redirect URIs in Google Cloud Console
- Make sure Railway domain is added to authorized origins
- Check that environment variables are correctly set

### Meeting Prep Not Working
- Check Railway logs for API errors
- Verify OpenAI API key is valid and has credits
- Verify Parallel AI key is valid

### 500 Errors
- Check the **"Logs"** tab in Railway
- Look for specific error messages
- Common issues:
  - Missing environment variables
  - API rate limits
  - Invalid API keys

---

## Custom Domain (Optional)

To use your own domain (e.g., `app.yourdomain.com`):

1. In Railway → Settings → Networking → **"Custom Domain"**
2. Add your domain
3. Update your DNS records as instructed
4. Update Google OAuth settings with new domain

---

## Scaling

Railway automatically scales based on traffic. For high traffic:

1. Go to Settings → **"Resources"**
2. Increase memory allocation if needed
3. Railway handles load balancing automatically

---

## Summary

✅ **You're now deployed!**

Your app is running at: `https://YOUR-APP-NAME.up.railway.app`

**Next steps:**
1. Share the link with users
2. Monitor logs for any issues
3. Set up custom domain if desired
4. Configure alerts for downtime

**Support:**
- Railway Docs: https://docs.railway.app
- Railway Discord: https://discord.gg/railway
- This app's logs: Railway Dashboard → Your Service → Logs
