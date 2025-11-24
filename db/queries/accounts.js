/**
 * Connected Accounts Database Queries
 *
 * CRUD operations for connected_accounts table (multiple Google accounts per user) using Supabase
 */

const { supabase } = require('../connection');

/**
 * Create or update a connected account
 * @param {Object} accountData - Account data
 * @returns {Promise<Object>} - Created/updated account
 */
async function createOrUpdateAccount({
    user_id,
    provider = 'google',
    account_email,
    account_name,
    access_token,
    refresh_token,
    token_expires_at,
    scopes = [],
    is_primary = false
}) {
    const { data, error} = await supabase
        .from('connected_accounts')
        .upsert(
            {
                user_id,
                provider,
                account_email,
                account_name,
                access_token,
                refresh_token,
                token_expires_at,
                scopes,
                is_primary
            },
            { onConflict: 'user_id, account_email' }
        )
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Get all connected accounts for a user
 * @param {string} userId - User UUID
 * @returns {Promise<Array>} - Array of connected accounts
 */
async function getAccountsByUserId(userId) {
    const { data, error } = await supabase
        .from('connected_accounts')
        .select('id, user_id, provider, account_email, account_name, access_token, refresh_token, token_expires_at, scopes, is_primary, created_at, updated_at')
        .eq('user_id', userId)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
}

/**
 * Get a specific account by ID
 * @param {string} accountId - Account UUID
 * @returns {Promise<Object|null>} - Account or null
 */
async function getAccountById(accountId) {
    const { data, error } = await supabase
        .from('connected_accounts')
        .select('*')
        .eq('id', accountId)
        .maybeSingle();

    if (error) throw error;
    return data;
}

/**
 * Get account by email and user
 * @param {string} userId - User UUID
 * @param {string} accountEmail - Account email
 * @returns {Promise<Object|null>} - Account or null
 */
async function getAccountByEmail(userId, accountEmail) {
    const { data, error } = await supabase
        .from('connected_accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('account_email', accountEmail)
        .maybeSingle();

    if (error) throw error;
    return data;
}

/**
 * Get primary account for a user
 * @param {string} userId - User UUID
 * @returns {Promise<Object|null>} - Primary account or null
 */
async function getPrimaryAccount(userId) {
    const { data, error } = await supabase
        .from('connected_accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('is_primary', true)
        .maybeSingle();

    if (error) throw error;
    return data;
}

/**
 * Update account token (after refresh)
 * @param {string} accountId - Account UUID
 * @param {Object} tokenData - New token data
 * @returns {Promise<Object>} - Updated account
 */
async function updateAccountToken(accountId, { access_token, token_expires_at }) {
    const { data, error } = await supabase
        .from('connected_accounts')
        .update({ access_token, token_expires_at })
        .eq('id', accountId)
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Set an account as primary (automatically unsets others via trigger)
 * @param {string} accountId - Account UUID
 * @returns {Promise<Object>} - Updated account
 */
async function setPrimaryAccount(accountId) {
    const { data, error } = await supabase
        .from('connected_accounts')
        .update({ is_primary: true })
        .eq('id', accountId)
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Delete a connected account
 * @param {string} accountId - Account UUID
 * @returns {Promise<boolean>} - Success
 */
async function deleteAccount(accountId) {
    const { data, error } = await supabase
        .from('connected_accounts')
        .delete()
        .eq('id', accountId)
        .select('id');

    if (error) throw error;
    return data && data.length > 0;
}

/**
 * Count accounts for a user
 * @param {string} userId - User UUID
 * @returns {Promise<number>} - Account count
 */
async function countUserAccounts(userId) {
    const { count, error } = await supabase
        .from('connected_accounts')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);

    if (error) throw error;
    return count || 0;
}

module.exports = {
    createOrUpdateAccount,
    getAccountsByUserId,
    getAccountById,
    getAccountByEmail,
    getPrimaryAccount,
    updateAccountToken,
    setPrimaryAccount,
    deleteAccount,
    countUserAccounts
};
