# Multi-Account Implementation Progress

## ✅ COMPLETED (Phase 1-2)

### Database Layer
- [x] Installed dependencies: `pg`, `express-session`, `cookie-parser`, `uuid`
- [x] Created `db/connection.js` - PostgreSQL connection pool with error handling
- [x] Created migrations:
  - `001_create_users.sql` - Users table with auto-updated timestamps
  - `002_create_connected_accounts.sql` - Connected accounts with constraints
  - `003_create_sessions.sql` - Sessions with expiration cleanup
- [x] Created `db/runMigrations.js` - Migration runner script
- [x] Created query modules:
  - `db/queries/users.js` - User CRUD operations
  - `db/queries/accounts.js` - Account management (9 functions)
  - `db/queries/sessions.js` - Session management (8 functions)
- [x] Updated `.env` with DATABASE_URL and SESSION_SECRET

### Key Features Implemented
- **Multi-account storage**: Each user can connect multiple Google accounts
- **Primary account**: Only one account marked as primary (enforced by trigger)
- **Token refresh**: Infrastructure for storing refresh_token and token_expires_at
- **Session-based auth**: Server-side sessions with secure random tokens
- **Automatic cleanup**: Triggers for updated_at, expired session cleanup function

## 🚧 IN PROGRESS

### Next Steps (Phases 3-6)

#### Phase 3: Service Layer (3-4 hours)
**Create `/services/` directory:**

1. **services/googleApi.js** - Extract from server.js
   - `fetchGmailMessages(accessToken, query, maxResults)`
   - `fetchDriveFiles(accessToken, query, maxResults)`
   - `fetchDriveFileContents(accessToken, files)`
   - `fetchCalendarEvents(accessToken, timeMin, timeMax)`

2. **services/multiAccountFetcher.js** - NEW
   - `fetchEmailsFromAllAccounts(accounts, attendees, meeting)`
   - `fetchFilesFromAllAccounts(accounts, attendees, meeting)`
   - `fetchCalendarFromAllAccounts(accounts, timeMin, timeMax)`
   - `mergeAndDedupe(resultsPerAccount)` - Deduplication logic

3. **services/tokenRefresh.js** - NEW
   - `ensureValidToken(account)` - Check expiration & auto-refresh
   - `refreshGoogleToken(refreshToken)` - OAuth token refresh

#### Phase 4: Routes (3-4 hours)
**Create `/routes/` directory:**

1. **routes/auth.js** - Authentication endpoints
   ```
   POST /auth/google/callback - Primary sign-in (exchange code for tokens)
   POST /auth/google/add-account - Add additional account
   POST /auth/logout - Delete session
   GET /auth/me - Get current user info
   ```

2. **routes/accounts.js** - Account management
   ```
   GET /api/accounts - List all connected accounts
   DELETE /api/accounts/:accountId - Remove account
   PUT /api/accounts/:accountId/set-primary - Set primary account
   ```

3. **routes/meetings.js** - Meeting prep (refactored)
   ```
   POST /api/prep-meeting - Multi-account meeting prep
   ```

#### Phase 5: Server.js Integration (2-3 hours)
1. Add session middleware (express-session + cookie-parser)
2. Initialize database connection on startup
3. Mount new route handlers
4. Add authentication middleware
5. Keep backward compatibility (support old token-in-body flow)

#### Phase 6: Frontend Updates (3-4 hours)
1. **Account Management UI** (in index.html)
   - Connected accounts list (shows all accounts)
   - "Add Account" button (triggers OAuth with prompt='consent')
   - Remove account button
   - Set primary account indicator

2. **Modified OAuth Flow**
   - Primary sign-in: Creates user + session cookie
   - Add account: Links to existing user session
   - Session token stored in httpOnly cookie (not localStorage)

3. **API Call Updates**
   - Remove `accessToken` from request bodies
   - Session cookie automatically sent with requests
   - Show loading states for multi-account fetching

#### Phase 7: Testing (2-3 hours)
1. Test with 2-3 connected accounts
2. Verify context aggregation (meeting on Account A, shows emails from A+B+C)
3. Test token refresh flows
4. Test account removal
5. Test primary account switching

## DATABASE SETUP INSTRUCTIONS

### Local Development

1. **Install PostgreSQL** (if not installed):
   ```bash
   # macOS with Homebrew
   brew install postgresql@15
   brew services start postgresql@15

   # Create database
   createdb humanmax
   ```

2. **Run Migrations**:
   ```bash
   node db/runMigrations.js
   ```

3. **Verify Setup**:
   ```bash
   # Should show all 3 tables created
   psql humanmax -c "\dt"
   ```

### Railway Production

1. **Add PostgreSQL Plugin** in Railway dashboard
2. **Copy DATABASE_URL** from Railway PostgreSQL service
3. **Add to Environment Variables** in Railway app settings:
   ```
   DATABASE_URL=<from PostgreSQL service>
   SESSION_SECRET=<generate random string>
   ```
4. **Deploy** - Migrations will run automatically on first start

## ARCHITECTURE OVERVIEW

### Data Flow (Multi-Account Meeting Prep)

```
User clicks "Prep Me"
  ↓
Frontend sends { meeting, attendees } (NO token, uses session cookie)
  ↓
Backend: req.session.userId → getAccountsByUserId(userId)
  ↓
Returns: [
  { account_email: 'work@company.com', access_token: '...', ... },
  { account_email: 'personal@gmail.com', access_token: '...', ... },
  { account_email: 'side@startup.com', access_token: '...', ... }
]
  ↓
Parallel fetching from ALL accounts:
  - fetchEmailsFromAllAccounts([work, personal, side], attendees, meeting)
  - fetchFilesFromAllAccounts([work, personal, side], attendees, meeting)
  ↓
Merge & deduplicate results by ID/hash
  ↓
Generate unified brief with context from ALL sources
  ↓
Return to frontend
```

### Session Flow

```
1. User signs in → OAuth callback → Exchange code for tokens
   ↓
2. Create/find user by email → createUser({ email, name, picture_url })
   ↓
3. Store account → createOrUpdateAccount({ user_id, account_email, tokens, ... })
   ↓
4. Create session → createSession(user_id) → Returns session_token
   ↓
5. Set httpOnly cookie → res.cookie('session', session_token, { httpOnly: true })
   ↓
6. All subsequent requests include session cookie automatically
   ↓
7. Middleware validates: findSessionByToken(session_token) → user_id
```

## BACKWARD COMPATIBILITY

During migration, support BOTH flows:

```javascript
// In /api/prep-meeting endpoint
app.post('/api/prep-meeting', async (req, res) => {
  let accounts = [];

  // NEW FLOW: Session-based (multi-account)
  if (req.session && req.session.userId) {
    accounts = await getAccountsByUserId(req.session.userId);
  }
  // OLD FLOW: Token in body (single account) - backward compatibility
  else if (req.body.accessToken) {
    accounts = [{
      access_token: req.body.accessToken,
      account_email: 'legacy-user'
    }];
  }
  else {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Same logic for both flows
  const results = await fetchFromAllAccounts(accounts, ...);
  // ...
});
```

## FILE STRUCTURE

```
/Users/anujaysurana/Desktop/humanMax/
├── db/
│   ├── connection.js ✅
│   ├── runMigrations.js ✅
│   ├── migrations/
│   │   ├── 001_create_users.sql ✅
│   │   ├── 002_create_connected_accounts.sql ✅
│   │   └── 003_create_sessions.sql ✅
│   └── queries/
│       ├── users.js ✅
│       ├── accounts.js ✅
│       └── sessions.js ✅
├── services/ (TO CREATE)
│   ├── googleApi.js
│   ├── multiAccountFetcher.js
│   └── tokenRefresh.js
├── routes/ (TO CREATE)
│   ├── auth.js
│   ├── accounts.js
│   └── meetings.js
├── middleware/ (TO CREATE)
│   └── auth.js
├── server.js (TO MODIFY)
├── index.html (TO MODIFY)
└── .env ✅ (updated with DATABASE_URL, SESSION_SECRET)
```

## ESTIMATED REMAINING TIME

- Phase 3 (Services): 3-4 hours
- Phase 4 (Routes): 3-4 hours
- Phase 5 (Server Integration): 2-3 hours
- Phase 6 (Frontend): 3-4 hours
- Phase 7 (Testing): 2-3 hours

**Total Remaining: 13-18 hours**

## NEXT IMMEDIATE STEPS

1. Create `services/` directory
2. Extract Google API functions from server.js to `services/googleApi.js`
3. Create `services/multiAccountFetcher.js` with parallel fetching logic
4. Create `services/tokenRefresh.js` with OAuth refresh logic

Then proceed to routes and server integration.
