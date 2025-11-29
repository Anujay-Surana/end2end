"""
Session Cleanup Service

Periodically cleans up expired sessions from the database
"""

import asyncio
import signal
from typing import Optional
from app.db.queries.sessions import delete_expired_sessions
from app.services.logger import logger


async def run_cleanup() -> int:
    """
    Run session cleanup
    Returns:
        Number of sessions deleted (0 if database unavailable)
    """
    try:
        deleted_count = await delete_expired_sessions()
        logger.info(f'Session cleanup completed: {deleted_count} sessions deleted', deletedCount=deleted_count)
        return deleted_count
    except Exception as error:
        # Check if it's a database connection error
        error_msg = str(error)
        if 'Internal server error' in error_msg:
            logger.warning('Session cleanup skipped: Database unavailable')
            return 0  # Return 0 instead of throwing - allows server to continue
        
        logger.error(f'Session cleanup error: {error_msg}', error=error_msg)
        # Don't throw - allow cleanup to fail silently so server continues
        return 0


_cleanup_task: Optional[asyncio.Task] = None


def start_periodic_cleanup(interval_hours: int = 6):
    """
    Start periodic session cleanup
    Runs every N hours by default
    Args:
        interval_hours: Cleanup interval in hours (default: 6)
    """
    interval_seconds = interval_hours * 60 * 60

    logger.info(f'Starting periodic session cleanup (every {interval_hours} hours)', intervalHours=interval_hours)

    async def cleanup_loop():
        # Run cleanup immediately on startup
        try:
            await run_cleanup()
        except Exception as err:
            # Only log if it's not a database connection error (already logged in run_cleanup)
            if 'Internal server error' not in str(err):
                logger.error(f'Initial session cleanup failed: {str(err)}', error=str(err))
        
        # Schedule periodic cleanup
        while True:
            await asyncio.sleep(interval_seconds)
            try:
                await run_cleanup()
            except Exception as err:
                # Only log if it's not a database connection error (already logged in run_cleanup)
                if 'Internal server error' not in str(err):
                    logger.error(f'Periodic session cleanup failed: {str(err)}', error=str(err))

    global _cleanup_task
    _cleanup_task = asyncio.create_task(cleanup_loop())

    # Handle graceful shutdown
    def signal_handler(sig, frame):
        logger.info('Stopping session cleanup service')
        if _cleanup_task:
            _cleanup_task.cancel()

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    return _cleanup_task

