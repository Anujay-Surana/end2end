/**
 * User Context Service
 *
 * Provides centralized user information retrieval and formatting for prompts
 * Ensures all prompts know who the user is and structure content from their perspective
 */

const { getPrimaryAccount } = require('../db/queries/accounts');
const logger = require('./logger');

/**
 * Get user context from request object
 * @param {Object} req - Express request object (should have req.user from auth middleware)
 * @returns {Promise<Object>} User context object with name, email, and formatted strings
 */
async function getUserContext(req) {
    try {
        // Get user from request (set by auth middleware)
        const user = req.user;
        
        if (!user) {
            logger.warn({ requestId: req.requestId }, 'No user found in request - user context unavailable');
            return null;
        }

        // Extract user info
        const userEmail = user.email;
        const userName = user.name || userEmail.split('@')[0];
        
        // Try to get primary account email (might be different from user email)
        let primaryAccountEmail = userEmail;
        try {
            if (user.id) {
                const primaryAccount = await getPrimaryAccount(user.id);
                if (primaryAccount && primaryAccount.account_email) {
                    primaryAccountEmail = primaryAccount.account_email;
                }
            }
        } catch (error) {
            logger.warn({ requestId: req.requestId, error: error.message }, 'Could not fetch primary account, using user email');
        }

        return {
            id: user.id,
            name: userName,
            email: userEmail,
            primaryAccountEmail: primaryAccountEmail,
            // Formatted strings for prompts
            formattedName: userName,
            formattedEmail: userEmail,
            // Context string for prompts
            contextString: `${userName} (${userEmail})`,
            // For filtering attendees
            emails: [userEmail, primaryAccountEmail].filter((e, i, arr) => arr.indexOf(e) === i) // unique
        };
    } catch (error) {
        logger.error({ requestId: req.requestId, error: error.message, stack: error.stack }, 'Error getting user context');
        return null;
    }
}

/**
 * Filter user from attendee list
 * @param {Array} attendees - Array of attendee objects
 * @param {Object} userContext - User context object from getUserContext
 * @returns {Array} Filtered attendees (excluding user)
 */
function filterUserFromAttendees(attendees, userContext) {
    if (!userContext || !attendees) {
        return attendees || [];
    }

    return attendees.filter(attendee => {
        const attendeeEmail = attendee.email || attendee.emailAddress;
        if (!attendeeEmail) return true; // Keep if no email
        
        // Filter out if email matches any of user's emails
        return !userContext.emails.some(userEmail => 
            userEmail.toLowerCase() === attendeeEmail.toLowerCase()
        );
    });
}

/**
 * Check if an email belongs to the user
 * @param {string} email - Email to check
 * @param {Object} userContext - User context object
 * @returns {boolean} True if email belongs to user
 */
function isUserEmail(email, userContext) {
    if (!userContext || !email) return false;
    
    return userContext.emails.some(userEmail => 
        userEmail.toLowerCase() === email.toLowerCase()
    );
}

/**
 * Format user context for prompts
 * @param {Object} userContext - User context object
 * @returns {string} Formatted string for prompts
 */
function formatUserContextForPrompt(userContext) {
    if (!userContext) {
        return 'the user';
    }
    
    return `${userContext.formattedName} (${userContext.formattedEmail})`;
}

/**
 * Get prompt prefix with user context
 * @param {Object} userContext - User context object
 * @param {string} assistantName - Name of the assistant (e.g., "Shadow")
 * @returns {string} Prompt prefix
 */
function getPromptPrefix(userContext, assistantName = 'Shadow') {
    if (!userContext) {
        return `You are ${assistantName}, an executive assistant preparing meeting briefs.`;
    }
    
    return `You are ${assistantName}, preparing ${userContext.formattedName} (${userContext.formattedEmail}) for their meetings.`;
}

module.exports = {
    getUserContext,
    filterUserFromAttendees,
    isUserEmail,
    formatUserContextForPrompt,
    getPromptPrefix
};

