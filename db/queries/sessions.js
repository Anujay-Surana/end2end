/**
 * Sessions Database Queries
 *
 * CRUD operations for sessions table using Supabase
 */

const { supabase } = require('../connection');
const { randomBytes } = require('crypto');

/**
 * Generate a secure random session token
 * @returns {string} - Random session token
 */
function generateSessionToken() {
    return randomBytes(32).toString('hex');
}

/**
 * Create a new session
 * @param {string} userId - User UUID
 * @param {number} expiresInDays - Session duration in days (default: 30)
 * @returns {Promise<Object>} - Created session
 */
async function createSession(userId, expiresInDays = 30) {
    const sessionToken = generateSessionToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    const { data, error } = await supabase
        .from('sessions')
        .insert({
            user_id: userId,
            session_token: sessionToken,
            expires_at: expiresAt.toISOString()
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Find session by token
 * @param {string} sessionToken - Session token
 * @returns {Promise<Object|null>} - Session or null
 */
async function findSessionByToken(sessionToken) {
    const { data, error } = await supabase
        .from('sessions')
        .select('*')
        .eq('session_token', sessionToken)
        .gt('expires_at', new Date().toISOString())
        .maybeSingle();

    if (error) throw error;
    return data;
}

/**
 * Delete a session (logout)
 * @param {string} sessionToken - Session token
 * @returns {Promise<boolean>} - Success
 */
async function deleteSession(sessionToken) {
    const { data, error } = await supabase
        .from('sessions')
        .delete()
        .eq('session_token', sessionToken)
        .select('id');

    if (error) throw error;
    return data && data.length > 0;
}

/**
 * Delete all sessions for a user (logout all devices)
 * @param {string} userId - User UUID
 * @returns {Promise<number>} - Number of sessions deleted
 */
async function deleteAllUserSessions(userId) {
    const { data, error } = await supabase
        .from('sessions')
        .delete()
        .eq('user_id', userId)
        .select('id');

    if (error) throw error;
    return data ? data.length : 0;
}

/**
 * Delete expired sessions (cleanup)
 * @returns {Promise<number>} - Number of sessions deleted
 */
async function deleteExpiredSessions() {
    const { data, error } = await supabase
        .from('sessions')
        .delete()
        .lt('expires_at', new Date().toISOString())
        .select('id');

    if (error) throw error;
    return data ? data.length : 0;
}

/**
 * Get all active sessions for a user
 * @param {string} userId - User UUID
 * @returns {Promise<Array>} - Array of sessions
 */
async function getUserSessions(userId) {
    const { data, error } = await supabase
        .from('sessions')
        .select('id, user_id, session_token, expires_at, created_at')
        .eq('user_id', userId)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

/**
 * Extend session expiration
 * @param {string} sessionToken - Session token
 * @param {number} expiresInDays - Additional days to extend
 * @returns {Promise<Object|null>} - Updated session or null
 */
async function extendSession(sessionToken, expiresInDays = 30) {
    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + expiresInDays);

    const { data, error } = await supabase
        .from('sessions')
        .update({ expires_at: newExpiresAt.toISOString() })
        .eq('session_token', sessionToken)
        .gt('expires_at', new Date().toISOString())
        .select()
        .maybeSingle();

    if (error) throw error;
    return data;
}

module.exports = {
    generateSessionToken,
    createSession,
    findSessionByToken,
    deleteSession,
    deleteAllUserSessions,
    deleteExpiredSessions,
    getUserSessions,
    extendSession
};
