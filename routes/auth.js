/**
 * Authentication Routes
 *
 * Handles Google OAuth authentication for primary and additional accounts
 */

const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const { createUser, findUserByEmail } = require('../db/queries/users');
const { createOrUpdateAccount, getPrimaryAccount, getAccountsByUserId } = require('../db/queries/accounts');
const { createSession, deleteSession } = require('../db/queries/sessions');
const { requireAuth } = require('../middleware/auth');
const { validateOAuthCallback } = require('../middleware/validation');
const { authLimiter } = require('../middleware/rateLimiter');
const { fetchUserProfile } = require('../services/googleApi');

/**
 * POST /auth/google/callback
 * Primary sign-in flow: Exchange OAuth code for tokens, create user + session
 */
router.post('/google/callback', authLimiter, validateOAuthCallback, async (req, res) => {
    try {
        const { code } = req.body;

        if (!code) {
            return res.status(400).json({ error: 'Authorization code required' });
        }

        // Determine redirect URI based on request origin
        // Check if this is a mobile request (from Capacitor app)
        const isMobileRequest = req.headers['x-capacitor-platform'] === 'ios' ||
                                req.headers['x-capacitor-platform'] === 'android' ||
                                req.headers['user-agent']?.includes('CapacitorHttp');
        
        // Get host and protocol (Express trust proxy will set req.protocol correctly for Railway)
        const host = req.get('host') || 'end2end-production.up.railway.app';
        // Force HTTPS if host is Railway (Express trust proxy should handle this, but be explicit)
        const protocol = host.includes('railway.app') ? 'https' : req.protocol;
        
        const redirectUri = isMobileRequest
            ? `${protocol}://${host}/auth/google/mobile-callback`
            : 'postmessage'; // For Google Identity Services web flow

        // Exchange code for tokens
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            })
        });

        if (!tokenResponse.ok) {
            const error = await tokenResponse.json();
            console.error('Token exchange error:', error);
            return res.status(400).json({ error: 'Failed to exchange authorization code' });
        }

        const tokens = await tokenResponse.json();
        const { access_token, refresh_token, expires_in, scope } = tokens;

        // Validate refresh_token is present (required for token refresh)
        if (!refresh_token) {
            console.warn(`⚠️  No refresh_token received during initial auth. This may cause issues with token refresh.`);
            // Log warning but continue - some OAuth flows don't return refresh_token on first auth
        }

        // Get user profile with retry logic
        let profile;
        let retryCount = 0;
        const maxRetries = 3;
        while (retryCount < maxRetries) {
            try {
                profile = await fetchUserProfile(access_token);
                break; // Success, exit retry loop
            } catch (error) {
                retryCount++;
                if (retryCount >= maxRetries) {
                    throw new Error(`Failed to fetch user profile after ${maxRetries} attempts: ${error.message}`);
                }
                // Exponential backoff: 200ms, 400ms, 800ms
                const delay = 200 * Math.pow(2, retryCount - 1);
                console.log(`⏳ Profile fetch failed, retrying in ${delay}ms (attempt ${retryCount}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        // Create or update user
        const user = await createUser({
            email: profile.email,
            name: profile.name,
            picture_url: profile.picture
        });

        console.log(`✅ User signed in: ${user.email}`);

        // Calculate token expiration
        const token_expires_at = new Date(Date.now() + expires_in * 1000);

        // Create or update account (mark as primary if first account)
        const existingPrimary = await getPrimaryAccount(user.id);
        const is_primary = !existingPrimary; // First account becomes primary

        await createOrUpdateAccount({
            user_id: user.id,
            provider: 'google',
            account_email: profile.email,
            account_name: profile.name,
            access_token,
            refresh_token,
            token_expires_at,
            scopes: scope ? scope.split(' ') : [],
            is_primary
        });

        console.log(`✅ Account saved: ${profile.email} (primary: ${is_primary})`);

        // Create session
        const session = await createSession(user.id, 30); // 30 days

        console.log(`✅ Session created for ${user.email}`);

        // Set session cookie
        res.cookie('session', session.session_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
        });

        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                picture: user.picture_url
            },
            session: {
                expires_at: session.expires_at
            },
            access_token: access_token,
            token_expires_at: token_expires_at
        });

    } catch (error) {
        console.error('Auth callback error:', error);
        
        // Check if it's a database connection error
        if (error.message && error.message.includes('Internal server error')) {
            return res.status(503).json({
                error: 'Database unavailable',
                message: 'Database connection failed. Please check your Supabase configuration or try again later.',
                details: 'The Supabase database is returning an internal server error. Verify your SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env file.'
            });
        }
        
        res.status(500).json({
            error: 'Authentication failed',
            message: error.message
        });
    }
});

/**
 * GET /auth/google/mobile-callback
 * Mobile OAuth redirect endpoint: Receives OAuth code from Google and redirects to app
 * The app will then call POST /auth/google/callback to exchange the code
 */
router.get('/google/mobile-callback', authLimiter, async (req, res) => {
    try {
        const { code, state, error } = req.query;

        // Handle OAuth errors
        if (error) {
            console.error('OAuth error:', error);
            const errorDescription = req.query.error_description || error;
            return res.redirect(`com.humanmax.app://auth/callback?error=${encodeURIComponent(error)}&error_description=${encodeURIComponent(errorDescription)}`);
        }

        if (!code) {
            return res.redirect(`com.humanmax.app://auth/callback?error=missing_code&error_description=${encodeURIComponent('Authorization code required')}`);
        }

        // Simply redirect to app with code and state
        // App will call POST /auth/google/callback to exchange code
        const redirectUrl = `com.humanmax.app://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || '')}`;
        res.redirect(redirectUrl);

    } catch (error) {
        console.error('Mobile auth callback error:', error);
        
        const errorMessage = error.message || 'Authentication failed';
        return res.redirect(`com.humanmax.app://auth/callback?error=auth_failed&error_description=${encodeURIComponent(errorMessage)}`);
    }
});

/**
 * POST /auth/google/add-account
 * Add additional account to existing user
 * Requires existing authentication
 */
router.post('/google/add-account', authLimiter, requireAuth, validateOAuthCallback, async (req, res) => {
    try {
        const { code } = req.body;
        const userId = req.userId;

        if (!code) {
            return res.status(400).json({ error: 'Authorization code required' });
        }

        // Exchange code for tokens
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: 'postmessage',
                grant_type: 'authorization_code'
            })
        });

        if (!tokenResponse.ok) {
            const error = await tokenResponse.json();
            console.error('Token exchange error:', error);
            return res.status(400).json({ error: 'Failed to exchange authorization code' });
        }

        const tokens = await tokenResponse.json();
        const { access_token, refresh_token, expires_in, scope } = tokens;

        // Validate refresh_token is present (required for token refresh)
        if (!refresh_token) {
            console.warn(`⚠️  No refresh_token received for account. User may need to re-authenticate with prompt=consent`);
            // Continue anyway - token will work but can't be refreshed
        }

        // Get user profile with retry logic (replaces 1-second delay hack)
        let profile;
        let retryCount = 0;
        const maxRetries = 3;
        while (retryCount < maxRetries) {
            try {
                profile = await fetchUserProfile(access_token);
                break; // Success, exit retry loop
            } catch (error) {
                retryCount++;
                if (retryCount >= maxRetries) {
                    throw new Error(`Failed to fetch user profile after ${maxRetries} attempts: ${error.message}`);
                }
                // Exponential backoff: 200ms, 400ms, 800ms
                const delay = 200 * Math.pow(2, retryCount - 1);
                console.log(`⏳ Profile fetch failed, retrying in ${delay}ms (attempt ${retryCount}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        // Calculate token expiration
        const token_expires_at = new Date(Date.now() + expires_in * 1000);

        // Add account (not primary - user already has a primary)
        await createOrUpdateAccount({
            user_id: userId,
            provider: 'google',
            account_email: profile.email,
            account_name: profile.name,
            access_token,
            refresh_token,
            token_expires_at,
            scopes: scope ? scope.split(' ') : [],
            is_primary: false
        });

        console.log(`✅ Additional account added: ${profile.email} for user ${req.user.email}`);

        res.json({
            success: true,
            account: {
                email: profile.email,
                name: profile.name,
                is_primary: false
            }
        });

    } catch (error) {
        console.error('Add account error:', error);
        res.status(500).json({
            error: 'Failed to add account',
            message: error.message
        });
    }
});

/**
 * POST /auth/logout
 * Delete session (logout)
 */
router.post('/logout', requireAuth, async (req, res) => {
    try {
        const sessionToken = req.cookies?.session;

        if (sessionToken) {
            await deleteSession(sessionToken);
            console.log(`✅ User logged out: ${req.user.email}`);
        }

        res.clearCookie('session');
        res.json({ success: true, message: 'Logged out successfully' });

    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({
            error: 'Logout failed',
            message: error.message
        });
    }
});

/**
 * GET /auth/me
 * Get current authenticated user info
 */
router.get('/me', requireAuth, async (req, res) => {
    try {
        // Get primary account's access token
        const accounts = await getAccountsByUserId(req.user.id);
        const primaryAccount = accounts.find(a => a.is_primary) || accounts[0];
        
        res.json({
            user: {
                id: req.user.id,
                email: req.user.email,
                name: req.user.name,
                picture: req.user.picture_url
            },
            accessToken: primaryAccount?.access_token || null
        });
    } catch (error) {
        console.error('Get user error:', error);
        
        // Check if it's a database connection error
        if (error.message && error.message.includes('Internal server error')) {
            return res.status(503).json({
                error: 'Database unavailable',
                message: 'Database connection failed. Please check your Supabase configuration.',
                details: 'The Supabase database is returning an internal server error. Verify your SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env file.'
            });
        }
        
        res.status(500).json({
            error: 'Failed to get user info',
            message: error.message
        });
    }
});

module.exports = router;
