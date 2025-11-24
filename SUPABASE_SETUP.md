# Supabase Setup Guide

## Why Supabase?
- ✅ PostgreSQL-based (all our migrations work as-is!)
- ✅ Free tier with generous limits (500MB database, 2GB bandwidth)
- ✅ Built-in authentication (optional, we're using custom OAuth)
- ✅ Auto-generated REST API
- ✅ Real-time subscriptions support
- ✅ Easy-to-use dashboard
- ✅ No server management needed

## Setup Steps

### 1. Create Supabase Project

1. Go to [https://supabase.com](https://supabase.com)
2. Click "Start your project"
3. Sign in with GitHub
4. Click "New Project"
5. Fill in:
   - **Name**: `humanmax` (or your preference)
   - **Database Password**: Generate a strong password (save it!)
   - **Region**: Choose closest to your users
   - **Pricing Plan**: Free tier is perfect for development

6. Wait 2-3 minutes for project to be created

### 2. Get API Credentials

1. Once project is created, go to **Settings** → **API**
2. Copy these values:

   ```
   Project URL: https://xxxxx.supabase.co
   anon/public key: eyJhbGc...
   service_role key: eyJhbGc... (click "Reveal" to see it)
   ```

3. Update your `.env` file:

   ```bash
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_ANON_KEY=eyJhbGc...
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
   ```

⚠️ **IMPORTANT**: Never commit the `service_role` key to git! It has full database access.

### 3. Run Database Migrations

Supabase provides multiple ways to run migrations:

#### Option A: Using SQL Editor (Easiest)

1. Go to Supabase Dashboard → **SQL Editor**
2. Create a new query
3. Copy contents of `db/migrations/001_create_users.sql`
4. Click **RUN**
5. Repeat for `002_create_connected_accounts.sql`
6. Repeat for `003_create_sessions.sql`

#### Option B: Using Supabase CLI

```bash
# Install Supabase CLI
npm install -g supabase

# Login to Supabase
supabase login

# Link your project
supabase link --project-ref xxxxx

# Run migrations
supabase db push

# Or run specific migration
supabase db execute --file db/migrations/001_create_users.sql
```

#### Option C: Using the Migration Runner (Our Script)

Our `db/runMigrations.js` script won't work directly with Supabase's client.
Instead, run migrations via SQL Editor (Option A) or CLI (Option B).

### 4. Verify Tables

1. Go to **Table Editor** in Supabase Dashboard
2. You should see 3 tables:
   - `users`
   - `connected_accounts`
   - `sessions`

3. Check the **Triggers** tab - you should see:
   - `update_users_updated_at`
   - `update_connected_accounts_updated_at`
   - `enforce_single_primary_account`

### 5. Test Connection

```bash
# Start your server
npm start

# You should see:
# ✅ Supabase connected successfully
```

## Supabase vs Raw PostgreSQL

Our code works with both! The query modules (`db/queries/*.js`) use standard SQL that works on both.

### Using Raw SQL (Current Approach)
```javascript
const { query } = require('./db/connection');
const result = await query(
  'SELECT * FROM users WHERE email = $1',
  [email]
);
```

### Using Supabase Methods (Alternative)
```javascript
const { db } = require('./db/connection');
const { data, error } = await db.users
  .select('*')
  .eq('email', email)
  .single();
```

Both work! Raw SQL gives us more control, Supabase methods provide type safety.

## Supabase Dashboard Features

### Table Editor
- View and edit data directly
- Manage table structure
- Set up relationships
- Configure RLS (Row Level Security)

### SQL Editor
- Write custom queries
- Run migrations
- Save queries for reuse

### Auth (Not Currently Used)
- We're using custom Google OAuth
- Could migrate to Supabase Auth later if desired

### Storage (Future Use)
- Could store meeting documents/attachments here

### Real-time (Future Use)
- Get live updates when new emails/documents are added
- Show real-time prep status to multiple devices

## Environment Variables

### Development (.env file)
```bash
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
SESSION_SECRET=your-random-secret-here
```

### Production (Railway)
Add the same variables to Railway environment variables:
1. Go to your Railway project
2. Click "Variables"
3. Add each variable
4. Redeploy

## Security Best Practices

### Row Level Security (RLS)
Supabase has built-in RLS. For now, we're using service_role key which bypasses RLS.

To enable RLS later:
1. Go to **Authentication** → **Policies**
2. Enable RLS on tables
3. Create policies like:
   ```sql
   -- Users can only see their own accounts
   CREATE POLICY "Users can view own accounts"
   ON connected_accounts FOR SELECT
   USING (auth.uid() = user_id);
   ```

### API Keys
- **anon key**: Safe for frontend (respects RLS policies)
- **service_role key**: NEVER expose to frontend (full access)

Our current setup:
- Frontend: No Supabase client (uses our API)
- Backend: Uses service_role key for full access

## Cost Estimation

### Free Tier Limits
- 500 MB database space
- 1 GB file storage
- 2 GB bandwidth
- 50,000 monthly active users

### When You Might Need Paid Tier
- Database > 500 MB (unlikely for 100s of users)
- Bandwidth > 2 GB/month (lots of traffic)
- Need point-in-time recovery
- Need daily backups

**For development and small-scale production: Free tier is perfect!**

## Backup Strategy

Supabase automatically backs up your database daily on paid plans.

For free tier:
1. Go to **Database** → **Backups**
2. Click "Create backup" manually
3. Or use pg_dump:
   ```bash
   # Get connection string from Supabase dashboard
   pg_dump "postgresql://postgres:[YOUR-PASSWORD]@db.xxxxx.supabase.co:5432/postgres" > backup.sql
   ```

## Migration from Railway PostgreSQL

If you already have data in Railway:

```bash
# Dump from Railway
pg_dump $RAILWAY_DATABASE_URL > backup.sql

# Restore to Supabase
psql "postgresql://postgres:[PASSWORD]@db.xxxxx.supabase.co:5432/postgres" < backup.sql
```

## Troubleshooting

### "relation does not exist" error
- Tables not created yet. Run migrations via SQL Editor.

### "JWT expired" error
- Regenerate API keys in Supabase dashboard

### Connection timeout
- Check SUPABASE_URL is correct
- Verify project is not paused (free tier pauses after 7 days inactivity)

### Service role key not working
- Make sure you copied the correct key
- Check for extra whitespace in .env file

## Next Steps

Once Supabase is set up:
1. ✅ Tables created
2. ✅ Connection working
3. ➡️ Continue with Phase 3: Service layer implementation
4. ➡️ Build auth routes
5. ➡️ Test multi-account functionality

## Useful Links

- [Supabase Dashboard](https://app.supabase.com)
- [Supabase Docs](https://supabase.com/docs)
- [PostgreSQL Docs](https://www.postgresql.org/docs/)
- [Our Implementation Progress](./MULTI_ACCOUNT_IMPLEMENTATION.md)
