/**
 * Token Refresh Service
 *
 * Manages OAuth token refresh for Google accounts.
 * Ensures all access tokens are valid before making API calls.
 */

const fetch = require('node-fetch');
const { updateAccountToken } = require('../db/queries/accounts');

// In-memory lock map to prevent concurrent token refreshes for the same account
const refreshLocks = new Map();

/**
 * Acquire lock for account token refresh
 * @param {string} accountId - Account ID
 * @returns {Promise<Function>} - Release function
 */
async function acquireRefreshLock(accountId) {
    // Wait if another refresh is in progress
    while (refreshLocks.has(accountId)) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Acquire lock
    refreshLocks.set(accountId, Date.now());
    
    // Return release function
    return () => {
        refreshLocks.delete(accountId);
    };
}

/**
 * Refresh a Google OAuth access token using refresh token
 * @param {string} refreshToken - Google refresh token
 * @returns {Promise<Object>} - { access_token, expires_in }
 */
async function refreshGoogleToken(refreshToken) {
    try {
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                refresh_token: refreshToken,
                grant_type: 'refresh_token'
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorCode = errorData.error;
            
            // Handle specific Google OAuth errors
            if (errorCode === 'invalid_grant') {
                // Refresh token has been revoked or is invalid
                console.error('❌ Refresh token invalid_grant error - token likely revoked');
                throw new Error('REVOKED_REFRESH_TOKEN');
            }
            
            const errorMessage = errorData.error_description || errorData.error || `HTTP ${response.status}`;
            console.error(`❌ Failed to refresh token: ${errorMessage}`, errorData);
            throw new Error(`Token refresh failed: ${errorMessage}`);
        }

        const data = await response.json();

        return {
            access_token: data.access_token,
            expires_in: data.expires_in // Usually 3600 seconds (1 hour)
        };
    } catch (error) {
        console.error('Error refreshing Google token:', error.message);
        throw error;
    }
}

/**
 * Ensure an account has a valid access token
 * Automatically refreshes if expired or expiring soon (within 5 minutes)
 * @param {Object} account - Account object with access_token, refresh_token, token_expires_at
 * @returns {Promise<Object>} - Account object with valid access_token
 */
async function ensureValidToken(account) {
    // Check if token exists
    if (!account.access_token) {
        throw new Error(`No access token for account ${account.account_email}`);
    }

    // Check if token is expired or expiring soon (within 5 minutes)
    const now = new Date();
    const expiresAt = account.token_expires_at ? new Date(account.token_expires_at) : null;

    // If token_expires_at is NULL, treat as expired (needs refresh)
    // This handles old accounts that don't have expiration set
    const isExpired = !expiresAt || (expiresAt - now < 5 * 60 * 1000); // NULL or expires in less than 5 minutes

    if (!isExpired) {
        // Token is still valid
        return account;
    }

    // Token is expired or expiring soon - refresh it
    // Use locking to prevent concurrent refreshes
    const releaseLock = await acquireRefreshLock(account.id);
    
    try {
        // Double-check token is still expired after acquiring lock
        // (another request might have refreshed it)
        const nowAfterLock = new Date();
        const expiresAtAfterLock = account.token_expires_at ? new Date(account.token_expires_at) : null;
        const stillExpired = !expiresAtAfterLock || (expiresAtAfterLock - nowAfterLock < 5 * 60 * 1000);
        
        if (!stillExpired) {
            // Token was refreshed by another request, return current account
            releaseLock();
            return account;
        }

        console.log(`🔄 Refreshing token for ${account.account_email} (expires: ${expiresAt?.toISOString() || 'unknown'})`);

        if (!account.refresh_token) {
            releaseLock();
            throw new Error(`No refresh token available for account ${account.account_email}. User needs to re-authenticate.`);
        }

        // Refresh the token
        const { access_token, expires_in } = await refreshGoogleToken(account.refresh_token);

        // Calculate new expiration time
        const newExpiresAt = new Date(Date.now() + expires_in * 1000);

        // Update database with new token
        const updatedAccount = await updateAccountToken(account.id, {
            access_token,
            token_expires_at: newExpiresAt
        });

        console.log(`✅ Token refreshed for ${account.account_email} (new expiry: ${newExpiresAt.toISOString()})`);

        // Return fresh account object from database (ensures we have latest data)
        releaseLock();
        return {
            ...account,
            access_token: updatedAccount.access_token,
            token_expires_at: updatedAccount.token_expires_at
        };
    } catch (error) {
        releaseLock();
        console.error(`❌ Failed to refresh token for ${account.account_email}:`, error.message);
        
        // If refresh token is revoked, mark account as needing re-auth
        if (error.message === 'REVOKED_REFRESH_TOKEN' || 
            error.message.includes('REVOKED_TOKEN') || 
            error.message.includes('invalid_grant')) {
            const revokedError = new Error(`REVOKED_TOKEN: Account ${account.account_email} needs to re-authenticate. Refresh token has been revoked.`);
            revokedError.isRevoked = true;
            throw revokedError;
        }
        
        throw new Error(`Token refresh failed for ${account.account_email}. User may need to re-authenticate.`);
    }
}

/**
 * Ensure all accounts have valid tokens
 * Refreshes expired tokens in parallel
 * @param {Array} accounts - Array of account objects
 * @returns {Promise<Object>} - { validAccounts: Array, failedAccounts: Array, allSucceeded: boolean }
 */
async function ensureAllTokensValid(accounts) {
    console.log(`\n🔐 Validating tokens for ${accounts.length} account(s)...`);

    const results = await Promise.allSettled(
        accounts.map(account => ensureValidToken(account))
    );

    const validAccounts = [];
    const failedAccounts = [];

    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            validAccounts.push(result.value);
        } else {
            const errorMessage = result.reason?.message || 'Unknown error';
            const isRevoked = result.reason?.isRevoked || 
                             errorMessage.includes('REVOKED_TOKEN') || 
                             errorMessage.includes('invalid_grant') ||
                             errorMessage.includes('REVOKED_REFRESH_TOKEN');
            
            failedAccounts.push({
                accountEmail: accounts[index].account_email,
                accountId: accounts[index].id,
                error: errorMessage,
                isRevoked: isRevoked
            });
        }
    });

    if (failedAccounts.length > 0) {
        console.warn(`⚠️  ${failedAccounts.length} account(s) failed token validation:`);
        failedAccounts.forEach(({ accountEmail, error }) => {
            console.warn(`   - ${accountEmail}: ${error}`);
        });
    }

    console.log(`✅ ${validAccounts.length}/${accounts.length} account(s) have valid tokens`);

    return {
        validAccounts,
        failedAccounts,
        allSucceeded: failedAccounts.length === 0,
        partialSuccess: validAccounts.length > 0 && failedAccounts.length > 0
    };
}

module.exports = {
    refreshGoogleToken,
    ensureValidToken,
    ensureAllTokensValid
};
