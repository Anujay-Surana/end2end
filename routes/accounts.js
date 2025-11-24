/**
 * Account Management Routes
 *
 * Handles listing, adding, removing, and managing connected Google accounts
 */

const express = require('express');
const router = express.Router();

const { getAccountsByUserId, deleteAccount, setPrimaryAccount } = require('../db/queries/accounts');
const { requireAuth } = require('../middleware/auth');
const { validateAccountId } = require('../middleware/validation');

/**
 * GET /api/accounts
 * List all connected accounts for authenticated user
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const accounts = await getAccountsByUserId(req.userId);

        // Don't expose sensitive tokens to frontend
        const sanitizedAccounts = accounts.map(account => ({
            id: account.id,
            email: account.account_email,
            name: account.account_name,
            provider: account.provider,
            is_primary: account.is_primary,
            scopes: account.scopes,
            token_expires_at: account.token_expires_at,
            created_at: account.created_at
        }));

        res.json({
            success: true,
            accounts: sanitizedAccounts
        });

    } catch (error) {
        console.error('Get accounts error:', error);
        res.status(500).json({
            error: 'Failed to get accounts',
            message: error.message
        });
    }
});

/**
 * DELETE /api/accounts/:accountId
 * Remove a connected account
 */
router.delete('/:accountId', requireAuth, validateAccountId, async (req, res) => {
    try {
        const { accountId } = req.params;
        const userId = req.userId;

        // Verify account belongs to user
        const accounts = await getAccountsByUserId(userId);
        const account = accounts.find(a => a.id === accountId);

        if (!account) {
            return res.status(404).json({
                error: 'Account not found',
                message: 'Account does not exist or does not belong to you'
            });
        }

        // Prevent deletion of primary account if user has multiple accounts
        if (account.is_primary && accounts.length > 1) {
            return res.status(400).json({
                error: 'Cannot delete primary account',
                message: 'Please set another account as primary before deleting this account'
            });
        }

        // Delete account
        await deleteAccount(accountId);

        console.log(`✅ Account removed: ${account.account_email} for user ${req.user.email}`);

        res.json({
            success: true,
            message: 'Account removed successfully'
        });

    } catch (error) {
        console.error('Delete account error:', error);
        res.status(500).json({
            error: 'Failed to delete account',
            message: error.message
        });
    }
});

/**
 * PUT /api/accounts/:accountId/set-primary
 * Set an account as the primary account
 */
router.put('/:accountId/set-primary', requireAuth, validateAccountId, async (req, res) => {
    try {
        const { accountId } = req.params;
        const userId = req.userId;

        // Verify account belongs to user
        const accounts = await getAccountsByUserId(userId);
        const account = accounts.find(a => a.id === accountId);

        if (!account) {
            return res.status(404).json({
                error: 'Account not found',
                message: 'Account does not exist or does not belong to you'
            });
        }

        // Set as primary (DB trigger will unset other primary accounts)
        await setPrimaryAccount(accountId);

        console.log(`✅ Primary account updated: ${account.account_email} for user ${req.user.email}`);

        res.json({
            success: true,
            message: 'Primary account updated successfully',
            account: {
                id: account.id,
                email: account.account_email,
                is_primary: true
            }
        });

    } catch (error) {
        console.error('Set primary account error:', error);
        res.status(500).json({
            error: 'Failed to set primary account',
            message: error.message
        });
    }
});

module.exports = router;
