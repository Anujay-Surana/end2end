/**
 * Authentication Middleware
 *
 * Validates session tokens and attaches user/account information to requests
 */

const { findSessionByToken } = require('../db/queries/sessions');
const { findUserById } = require('../db/queries/users');

/**
 * Require authentication - blocks request if no valid session
 * Attaches req.user and req.userId to authenticated requests
 */
async function requireAuth(req, res, next) {
    try {
        // Get session token from cookie or Authorization header
        const sessionToken = req.cookies?.session ||
                            req.headers.authorization?.replace('Bearer ', '');

        if (!sessionToken) {
            return res.status(401).json({
                error: 'Authentication required',
                message: 'No session token provided'
            });
        }

        // Find session in database (query already filters expired sessions)
        const session = await findSessionByToken(sessionToken);

        if (!session) {
            return res.status(401).json({
                error: 'Invalid session',
                message: 'Session expired or invalid. Please sign in again.'
            });
        }

        // Double-check expiration even though DB query filters it
        // This handles edge cases like clock skew or race conditions
        const now = new Date();
        const expiresAt = session.expires_at ? new Date(session.expires_at) : null;
        
        if (expiresAt && expiresAt <= now) {
            return res.status(401).json({
                error: 'Session expired',
                message: 'Session has expired. Please sign in again.'
            });
        }

        // Find user
        const user = await findUserById(session.user_id);

        if (!user) {
            return res.status(401).json({
                error: 'User not found',
                message: 'Associated user account not found'
            });
        }

        // Attach user info to request
        req.userId = user.id;
        req.user = user;
        req.sessionId = session.id;

        next();
    } catch (error) {
        console.error('Auth middleware error:', error);
        
        // Check if it's a database connection error
        if (error.message && error.message.includes('Internal server error')) {
            return res.status(503).json({
                error: 'Database unavailable',
                message: 'Database connection failed. Authentication cannot be verified.',
                details: 'The Supabase database is returning an internal server error. Verify your SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env file.'
            });
        }
        
        return res.status(500).json({
            error: 'Authentication error',
            message: 'Failed to validate session'
        });
    }
}

/**
 * Optional authentication - doesn't block if no session, but attaches user if present
 * Useful for endpoints that work both authenticated and unauthenticated
 */
async function optionalAuth(req, res, next) {
    try {
        const sessionToken = req.cookies?.session ||
                            req.headers.authorization?.replace('Bearer ', '');

        if (!sessionToken) {
            // No session, continue without user
            return next();
        }

        const session = await findSessionByToken(sessionToken);

        if (session) {
            // Double-check expiration even though DB query filters it
            const now = new Date();
            const expiresAt = session.expires_at ? new Date(session.expires_at) : null;
            
            if (!expiresAt || expiresAt > now) {
                const user = await findUserById(session.user_id);
                if (user) {
                    req.userId = user.id;
                    req.user = user;
                    req.sessionId = session.id;
                }
            }
        }

        next();
    } catch (error) {
        console.error('Optional auth middleware error:', error);
        // Don't block request on error, just continue without user
        next();
    }
}

/**
 * Get user ID from request (works with both new session-based and old token-based auth)
 * This provides backward compatibility during migration
 */
function getUserId(req) {
    return req.userId;
}

/**
 * Check if request is authenticated
 */
function isAuthenticated(req) {
    return !!req.userId;
}

module.exports = {
    requireAuth,
    optionalAuth,
    getUserId,
    isAuthenticated
};
