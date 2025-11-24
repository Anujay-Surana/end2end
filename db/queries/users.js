/**
 * User Database Queries
 *
 * CRUD operations for users table using Supabase
 */

const { supabase } = require('../connection');

/**
 * Create a new user
 * @param {Object} userData - User data
 * @param {string} userData.email - User email
 * @param {string} userData.name - User name
 * @param {string} userData.picture_url - User profile picture URL
 * @returns {Promise<Object>} - Created user
 */
async function createUser({ email, name, picture_url }) {
    const { data, error } = await supabase
        .from('users')
        .upsert(
            { email, name, picture_url },
            { onConflict: 'email', ignoreDuplicates: false }
        )
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Find user by email
 * @param {string} email - User email
 * @returns {Promise<Object|null>} - User or null
 */
async function findUserByEmail(email) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('email', email)
        .maybeSingle();

    if (error) throw error;
    return data;
}

/**
 * Find user by ID
 * @param {string} userId - User UUID
 * @returns {Promise<Object|null>} - User or null
 */
async function findUserById(userId) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

    if (error) throw error;
    return data;
}

/**
 * Update user
 * @param {string} userId - User UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated user
 */
async function updateUser(userId, updates) {
    const { name, picture_url } = updates;

    // Build update object conditionally (COALESCE logic in JS)
    const updateData = {};
    if (name !== undefined && name !== null) updateData.name = name;
    if (picture_url !== undefined && picture_url !== null) updateData.picture_url = picture_url;

    const { data, error } = await supabase
        .from('users')
        .update(updateData)
        .eq('id', userId)
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Delete user (and all associated accounts via CASCADE)
 * @param {string} userId - User UUID
 * @returns {Promise<boolean>} - Success
 */
async function deleteUser(userId) {
    const { data, error } = await supabase
        .from('users')
        .delete()
        .eq('id', userId)
        .select('id');

    if (error) throw error;
    return data && data.length > 0;
}

module.exports = {
    createUser,
    findUserByEmail,
    findUserById,
    updateUser,
    deleteUser
};
