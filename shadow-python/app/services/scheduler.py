"""
Scheduler Service

Manages timezone-aware scheduled tasks using APScheduler:
- Midnight brief generation (per-user timezone)
- 9 AM daily summaries (per-user timezone)
- 15-minute pre-meeting reminders
"""

import asyncio
from datetime import datetime, timedelta
from typing import Dict, Any
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
import pytz
from app.services.logger import logger
from app.db.queries.users import find_user_by_id
from app.db.connection import supabase


class SchedulerService:
    def __init__(self):
        self.scheduler = AsyncIOScheduler(timezone='UTC')
        self.is_running = False
    
    def start(self):
        """Start the scheduler"""
        if self.is_running:
            logger.warn('Scheduler already running')
            return
        
        logger.info('Starting scheduler service...')
        
        # Schedule periodic tasks that check all users
        # These run every hour to check for users in different timezones
        self.scheduler.add_job(
            self._check_midnight_briefs,
            trigger=CronTrigger(minute=0),  # Run at the top of every hour
            id='midnight_briefs_check',
            replace_existing=True
        )
        
        self.scheduler.add_job(
            self._check_daily_summaries,
            trigger=CronTrigger(minute=0),  # Run at the top of every hour
            id='daily_summaries_check',
            replace_existing=True
        )
        
        # Schedule 15-minute reminder checks (run every minute)
        self.scheduler.add_job(
            self._check_meeting_reminders,
            trigger=CronTrigger(second=0),  # Run at the start of every minute
            id='meeting_reminders_check',
            replace_existing=True
        )
        
        self.scheduler.start()
        self.is_running = True
        logger.info('Scheduler service started')
    
    def stop(self):
        """Stop the scheduler"""
        if not self.is_running:
            return
        
        logger.info('Stopping scheduler service...')
        self.scheduler.shutdown()
        self.is_running = False
        logger.info('Scheduler service stopped')
    
    async def _check_midnight_briefs(self):
        """Check for users whose local time is midnight and generate briefs"""
        try:
            from app.services.midnight_brief_generator import generate_briefs_for_user
            
            # Get all users
            response = supabase.table('users').select('id, timezone').execute()
            if hasattr(response, 'error') and response.error:
                logger.error(f'Error fetching users for midnight briefs: {response.error.message}')
                return
            
            users = response.data if response.data else []
            
            # Check each user's timezone
            for user in users:
                user_id = user.get('id')
                user_timezone_str = user.get('timezone', 'UTC')
                
                try:
                    user_tz = pytz.timezone(user_timezone_str)
                except pytz.exceptions.UnknownTimeZoneError:
                    logger.warn(f'Unknown timezone for user {user_id}: {user_timezone_str}, using UTC')
                    user_tz = pytz.UTC
                
                # Get current time in user's timezone
                now_utc = datetime.now(pytz.UTC)
                now_user_tz = now_utc.astimezone(user_tz)
                
                # Check if it's midnight (00:00-00:59) in user's timezone
                if now_user_tz.hour == 0:
                    logger.info(f'Generating midnight briefs for user {user_id} (timezone: {user_timezone_str})')
                    try:
                        await generate_briefs_for_user(user_id)
                    except Exception as e:
                        logger.error(f'Error generating briefs for user {user_id}: {str(e)}')
                
        except Exception as e:
            logger.error(f'Error in midnight briefs check: {str(e)}')
    
    async def _check_daily_summaries(self):
        """Check for users whose local time is 9 AM and send daily summaries"""
        try:
            from app.services.daily_summary import send_daily_summary_for_user
            
            # Get all users
            response = supabase.table('users').select('id, timezone').execute()
            if hasattr(response, 'error') and response.error:
                logger.error(f'Error fetching users for daily summaries: {response.error.message}')
                return
            
            users = response.data if response.data else []
            
            # Check each user's timezone
            for user in users:
                user_id = user.get('id')
                user_timezone_str = user.get('timezone', 'UTC')
                
                try:
                    user_tz = pytz.timezone(user_timezone_str)
                except pytz.exceptions.UnknownTimeZoneError:
                    logger.warn(f'Unknown timezone for user {user_id}: {user_timezone_str}, using UTC')
                    user_tz = pytz.UTC
                
                # Get current time in user's timezone
                now_utc = datetime.now(pytz.UTC)
                now_user_tz = now_utc.astimezone(user_tz)
                
                # Check if it's 9 AM (09:00-09:59) in user's timezone
                if now_user_tz.hour == 9:
                    logger.info(f'Sending daily summary for user {user_id} (timezone: {user_timezone_str})')
                    try:
                        await send_daily_summary_for_user(user_id)
                    except Exception as e:
                        logger.error(f'Error sending daily summary for user {user_id}: {str(e)}')
                
        except Exception as e:
            logger.error(f'Error in daily summaries check: {str(e)}')
    
    async def _check_meeting_reminders(self):
        """Check for meetings starting in 15 minutes and send reminders"""
        try:
            from app.services.notification_dispatcher import send_meeting_reminders
            
            # Get all users with devices
            response = supabase.table('users').select('id, timezone').execute()
            if hasattr(response, 'error') and response.error:
                logger.error(f'Error fetching users for meeting reminders: {response.error.message}')
                return
            
            users = response.data if response.data else []
            
            # Check each user
            for user in users:
                user_id = user.get('id')
                user_timezone_str = user.get('timezone', 'UTC')
                
                try:
                    await send_meeting_reminders(user_id, user_timezone_str)
                except Exception as e:
                    logger.error(f'Error checking meeting reminders for user {user_id}: {str(e)}')
                
        except Exception as e:
            logger.error(f'Error in meeting reminders check: {str(e)}')


# Global scheduler instance
_scheduler_instance: SchedulerService = None


def get_scheduler() -> SchedulerService:
    """Get the global scheduler instance"""
    global _scheduler_instance
    if _scheduler_instance is None:
        _scheduler_instance = SchedulerService()
    return _scheduler_instance


def start_scheduler():
    """Start the global scheduler"""
    scheduler = get_scheduler()
    scheduler.start()


def stop_scheduler():
    """Stop the global scheduler"""
    scheduler = get_scheduler()
    scheduler.stop()

