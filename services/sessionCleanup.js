/**
 * Session Cleanup Service
 *
 * Periodically cleans up expired sessions from the database
 */

const { deleteExpiredSessions } = require('../db/queries/sessions');
const logger = require('./logger');

/**
 * Run session cleanup
 * @returns {Promise<number>} - Number of sessions deleted (0 if database unavailable)
 */
async function runCleanup() {
    try {
        const deletedCount = await deleteExpiredSessions();
        logger.info({ deletedCount }, 'Session cleanup completed');
        return deletedCount;
    } catch (error) {
        // Check if it's a database connection error
        if (error.message && error.message.includes('Internal server error')) {
            logger.warn('Session cleanup skipped: Database unavailable');
            return 0; // Return 0 instead of throwing - allows server to continue
        }
        
        logger.error({ error: error.message }, 'Session cleanup error');
        // Don't throw - allow cleanup to fail silently so server continues
        return 0;
    }
}

/**
 * Start periodic session cleanup
 * Runs every 6 hours by default
 * @param {number} intervalHours - Cleanup interval in hours (default: 6)
 */
function startPeriodicCleanup(intervalHours = 6) {
    const intervalMs = intervalHours * 60 * 60 * 1000;

    logger.info({ intervalHours }, 'Starting periodic session cleanup');

    // Run cleanup immediately on startup
    runCleanup().catch(err => {
        // Only log if it's not a database connection error (already logged in runCleanup)
        if (!err.message || !err.message.includes('Internal server error')) {
            logger.error({ error: err.message }, 'Initial session cleanup failed');
        }
    });

    // Schedule periodic cleanup
    const intervalId = setInterval(() => {
        runCleanup().catch(err => {
            // Only log if it's not a database connection error (already logged in runCleanup)
            if (!err.message || !err.message.includes('Internal server error')) {
                logger.error({ error: err.message }, 'Periodic session cleanup failed');
            }
        });
    }, intervalMs);

    // Handle graceful shutdown
    process.on('SIGTERM', () => {
        logger.info('Stopping session cleanup service (SIGTERM)');
        clearInterval(intervalId);
    });

    process.on('SIGINT', () => {
        logger.info('Stopping session cleanup service (SIGINT)');
        clearInterval(intervalId);
    });

    return intervalId;
}

module.exports = {
    runCleanup,
    startPeriodicCleanup
};

