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
        // HTTP headers are case-insensitive, but Express normalizes them to lowercase
        const capacitorPlatform = req.headers['x-capacitor-platform'] || req.headers['X-Capacitor-Platform'];
        const isMobileRequest = capacitorPlatform === 'ios' ||
                                capacitorPlatform === 'android' ||
                                req.headers['user-agent']?.includes('CapacitorHttp');
        
        console.log('POST /auth/google/callback:', {
            capacitorPlatform,
            isMobileRequest,
            userAgent: req.headers['user-agent'],
            allHeaders: Object.keys(req.headers).filter(h => h.toLowerCase().includes('capacitor'))
        });
        
        // For mobile requests, use the exact Railway URL to ensure it matches Google Cloud Console
        // This must match EXACTLY what's registered in Google Cloud Console
        let redirectUri;
        if (isMobileRequest) {
            // Hardcode Railway URL to ensure exact match with Google Cloud Console
            redirectUri = 'https://end2end-production.up.railway.app/auth/google/mobile-callback';
        } else {
            // For web, use postmessage (Google Identity Services)
            redirectUri = 'postmessage';
        }

        console.log('Using redirect URI:', redirectUri, {
            isMobileRequest,
            host: req.get('host'),
            protocol: req.protocol,
            xForwardedProto: req.headers['x-forwarded-proto']
        });

        // Exchange code for tokens
        console.log('Exchanging code with Google:', {
            codeLength: code.length,
            redirectUri,
            clientId: process.env.GOOGLE_CLIENT_ID ? 'present' : 'missing',
            clientSecret: process.env.GOOGLE_CLIENT_SECRET ? 'present' : 'missing'
        });
        
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

        const responseText = await tokenResponse.text();
        let tokens;
        let error;
        
        try {
            tokens = JSON.parse(responseText);
        } catch (e) {
            console.error('Failed to parse token response as JSON:', responseText);
            return res.status(500).json({ 
                error: 'Invalid response from Google',
                details: 'Failed to parse token response'
            });
        }

        if (!tokenResponse.ok) {
            error = tokens;
            console.error('Token exchange error:', {
                status: tokenResponse.status,
                statusText: tokenResponse.statusText,
                error: error,
                redirectUri,
                isMobileRequest,
                rawResponse: responseText.substring(0, 500) // First 500 chars
            });
            return res.status(400).json({ 
                error: 'Failed to exchange authorization code',
                details: error.error_description || error.error || 'Unknown error',
                googleError: error.error
            });
        }
        
        // Check if response contains error even if status is OK (shouldn't happen, but just in case)
        if (tokens.error) {
            console.error('Token response contains error despite OK status:', tokens);
            return res.status(400).json({ 
                error: 'Failed to exchange authorization code',
                details: tokens.error_description || tokens.error || 'Unknown error',
                googleError: tokens.error
            });
        }
        
        console.log('✅ Token exchange successful! Response:', {
            hasAccessToken: !!tokens.access_token,
            hasRefreshToken: !!tokens.refresh_token,
            tokenType: tokens.token_type,
            expiresIn: tokens.expires_in,
            scope: tokens.scope,
            accessTokenPreview: tokens.access_token ? tokens.access_token.substring(0, 20) + '...' : 'MISSING',
            fullResponseKeys: Object.keys(tokens)
        });
        
        const { access_token, refresh_token, expires_in, scope } = tokens;

        // Validate access_token is present
        if (!access_token) {
            console.error('❌ No access_token in token response! Full response:', JSON.stringify(tokens, null, 2));
            return res.status(400).json({ 
                error: 'Failed to exchange authorization code',
                details: 'No access token received from Google'
            });
        }
        
        console.log('✅ Access token received, length:', access_token.length);

        // Validate refresh_token is present (required for token refresh)
        if (!refresh_token) {
            console.warn(`⚠️  No refresh_token received during initial auth. This may cause issues with token refresh.`);
            // Log warning but continue - some OAuth flows don't return refresh_token on first auth
        }

        console.log('Fetching user profile with access token...');
        // Get user profile with retry logic
        let profile;
        let retryCount = 0;
        const maxRetries = 3;
        while (retryCount < maxRetries) {
            try {
                profile = await fetchUserProfile(access_token);
                console.log('✅ User profile fetched successfully:', { email: profile.email });
                break; // Success, exit retry loop
            } catch (error) {
                retryCount++;
                console.error(`❌ Profile fetch failed (attempt ${retryCount}/${maxRetries}):`, error.message);
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
                token: session.session_token, // Include session token for mobile apps (cookies may not work)
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
            const errorUrl = `com.humanmax.app://auth/callback?error=${encodeURIComponent(error)}&error_description=${encodeURIComponent(errorDescription)}`;
            // Return HTML page with deep link fallback
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Sign-in Error</title>
                    <script>
                        window.location.href = '${errorUrl}';
                        setTimeout(function() {
                            document.body.innerHTML = '<div style="font-family: -apple-system, sans-serif; text-align: center; padding: 40px;"><h1>Sign-in Error</h1><p>Please return to the HumanMax app.</p></div>';
                        }, 1000);
                    </script>
                </head>
                <body>
                    <h1>Redirecting...</h1>
                </body>
                </html>
            `);
        }

        if (!code) {
            // Return HTML page with deep link fallback
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Redirecting...</title>
                    <script>
                        window.location.href = 'com.humanmax.app://auth/callback?error=missing_code&error_description=${encodeURIComponent('Authorization code required')}';
                        setTimeout(function() {
                            document.body.innerHTML = '<h1>Redirecting to app...</h1><p>If the app doesn\'t open, please return to the HumanMax app.</p>';
                        }, 1000);
                    </script>
                </head>
                <body>
                    <h1>Redirecting to app...</h1>
                </body>
                </html>
            `);
        }

        // Return HTML page with deep link (better Safari compatibility)
        // App will call POST /auth/google/callback to exchange code
        const redirectUrl = `com.humanmax.app://auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || '')}`;
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Redirecting to HumanMax...</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                        text-align: center;
                        padding: 40px 20px;
                        background: #000;
                        color: #fff;
                        margin: 0;
                    }
                    .container {
                        max-width: 400px;
                        margin: 0 auto;
                    }
                    h1 { margin-top: 0; }
                    .button {
                        display: inline-block;
                        margin-top: 20px;
                        padding: 12px 24px;
                        background: #fff;
                        color: #000;
                        text-decoration: none;
                        border-radius: 8px;
                        font-weight: 500;
                    }
                </style>
                <script>
                    // Try multiple methods to open deep link
                    function openApp() {
                        const url = '${redirectUrl}';
                        
                        // Method 1: Direct location change
                        window.location.href = url;
                        
                        // Method 2: Try iframe (for Safari)
                        setTimeout(function() {
                            const iframe = document.createElement('iframe');
                            iframe.style.display = 'none';
                            iframe.src = url;
                            document.body.appendChild(iframe);
                            
                            setTimeout(function() {
                                document.body.removeChild(iframe);
                            }, 1000);
                        }, 100);
                        
                        // Method 3: Show manual button after delay
                        setTimeout(function() {
                            document.getElementById('manual-button').style.display = 'block';
                        }, 1500);
                    }
                    
                    // Auto-trigger on load
                    window.onload = openApp;
                    
                    // Also try on user interaction (Safari requires this)
                    document.addEventListener('click', function() {
                        openApp();
                    }, { once: true });
                </script>
            </head>
            <body>
                <div class="container">
                    <h1>✅ Sign-in Successful!</h1>
                    <p>Opening HumanMax app...</p>
                    <a href="${redirectUrl}" id="manual-button" class="button" style="display: none;">
                        Open HumanMax App
                    </a>
                    <p style="color: #666; font-size: 14px; margin-top: 30px;">
                        If the app doesn't open, tap the button above.
                    </p>
                </div>
            </body>
            </html>
        `);

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

