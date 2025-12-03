"""
Cron Midnight - Alternative Approach (Not Currently Used)

This file contains the MIDNIGHT-based approach for brief generation:
- At midnight (user's timezone), generate briefs for ALL of tomorrow's meetings
- One batch per day per user

The active approach is in cron.py (hourly, upcoming meetings).

To use this approach instead:
1. Import midnight_router from this file
2. Include it in main.py
3. Update Railway cron to call /api/cron/generate-midnight-briefs
"""

import asyncio
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, Request, HTTPException
import pytz

from app.services.logger import logger
from app.db.connection import supabase
from app.db.queries.accounts import get_accounts_by_user_id
from app.db.queries.meeting_briefs import upsert_meeting_brief, get_briefs_for_user_date
from app.services.token_refresh import ensure_all_tokens_valid
from app.services.google_api import fetch_calendar_events
from app.services.brief_generator import generate_brief_with_one_liner

# Separate router - not included by default
midnight_router = APIRouter()


async def get_users_at_midnight() -> List[Dict[str, Any]]:
    """
    Get all users whose local timezone is currently at midnight (00:00-00:59)
    """
    try:
        # Get all users with their timezones
        response = supabase.table('users').select('id, email, timezone').execute()
        
        if hasattr(response, 'error') and response.error:
            logger.error(f'Failed to fetch users: {response.error.message}')
            return []
        
        users_at_midnight = []
        now_utc = datetime.now(timezone.utc)
        
        for user in (response.data or []):
            user_timezone = user.get('timezone', 'UTC')
            try:
                tz = pytz.timezone(user_timezone)
                user_local_time = now_utc.astimezone(tz)
                
                # Check if it's between 00:00 and 00:59 in user's timezone
                if user_local_time.hour == 0:
                    users_at_midnight.append(user)
                    logger.info(
                        f'User {user.get("email")} is at midnight',
                        userId=user.get('id'),
                        timezone=user_timezone,
                        localTime=user_local_time.isoformat()
                    )
            except Exception as tz_error:
                logger.warning(
                    f'Invalid timezone for user {user.get("email")}: {user_timezone}',
                    error=str(tz_error)
                )
                continue
        
        return users_at_midnight
        
    except Exception as error:
        logger.error(f'Error getting users at midnight: {str(error)}')
        return []


async def fetch_tomorrow_meetings(user_id: str, user_timezone: str) -> List[Dict[str, Any]]:
    """
    Fetch calendar meetings for tomorrow (in user's timezone)
    """
    try:
        # Get user's accounts
        accounts = await get_accounts_by_user_id(user_id)
        if not accounts:
            logger.warning(f'No accounts found for user {user_id}')
            return []
        
        # Validate tokens
        token_result = await ensure_all_tokens_valid(accounts)
        valid_accounts = token_result.get('validAccounts', [])
        
        if not valid_accounts:
            logger.warning(f'No valid accounts for user {user_id}')
            return []
        
        # Calculate tomorrow in user's timezone
        try:
            tz = pytz.timezone(user_timezone)
        except:
            tz = pytz.UTC
        
        now_user_tz = datetime.now(tz)
        tomorrow = now_user_tz + timedelta(days=1)
        
        # Set time boundaries for tomorrow (in user's timezone, converted to UTC)
        start_of_day = tomorrow.replace(hour=0, minute=0, second=0, microsecond=0)
        end_of_day = tomorrow.replace(hour=23, minute=59, second=59, microsecond=999999)
        
        # Convert to UTC for API calls
        start_utc = start_of_day.astimezone(timezone.utc)
        end_utc = end_of_day.astimezone(timezone.utc)
        
        # Fetch meetings from all accounts
        all_meetings = []
        
        async def fetch_account_meetings(account):
            try:
                events = await fetch_calendar_events(
                    account,
                    start_utc.isoformat(),
                    end_utc.isoformat(),
                    100
                )
                return [{**event, 'accountEmail': account.get('account_email')} for event in events]
            except Exception as error:
                logger.error(
                    f'Error fetching meetings for account {account.get("account_email")}: {str(error)}'
                )
                return []
        
        meeting_arrays = await asyncio.gather(*[fetch_account_meetings(acc) for acc in valid_accounts])
        all_meetings = [m for arr in meeting_arrays for m in arr]
        
        # Sort by start time
        def get_start_time(meeting):
            start = meeting.get('start', {})
            if isinstance(start, dict):
                return start.get('dateTime') or start.get('date') or ''
            return str(start) if start else ''
        
        all_meetings.sort(key=lambda m: get_start_time(m))
        
        logger.info(
            f'Fetched {len(all_meetings)} meetings for user {user_id} for tomorrow',
            date=tomorrow.strftime('%Y-%m-%d')
        )
        
        return all_meetings
        
    except Exception as error:
        logger.error(f'Error fetching tomorrow meetings for user {user_id}: {str(error)}')
        return []


async def generate_briefs_for_user(user: Dict[str, Any], meetings: List[Dict[str, Any]], request_id: str) -> int:
    """
    Generate briefs for all meetings for a user
    Returns number of briefs generated
    """
    user_id = user.get('id')
    user_timezone = user.get('timezone', 'UTC')
    briefs_generated = 0
    
    for meeting in meetings:
        meeting_id = meeting.get('id')
        if not meeting_id:
            continue
        
        try:
            logger.info(
                f'Generating brief for meeting {meeting.get("summary", "Untitled")}',
                userId=user_id,
                meetingId=meeting_id,
                requestId=request_id
            )
            
            # Generate brief with one-liner
            brief_result = await generate_brief_with_one_liner(
                user_id=user_id,
                meeting=meeting,
                attendees=meeting.get('attendees', []),
                request_id=request_id
            )
            
            if brief_result:
                # Calculate meeting date
                start = meeting.get('start', {})
                if isinstance(start, dict):
                    meeting_date_str = start.get('dateTime') or start.get('date')
                else:
                    meeting_date_str = str(start) if start else None
                
                if meeting_date_str:
                    try:
                        meeting_date = datetime.fromisoformat(meeting_date_str.replace('Z', '+00:00')).date()
                    except:
                        meeting_date = datetime.now(timezone.utc).date() + timedelta(days=1)
                else:
                    meeting_date = datetime.now(timezone.utc).date() + timedelta(days=1)
                
                # Store brief in database
                await upsert_meeting_brief(
                    user_id=user_id,
                    meeting_id=meeting_id,
                    brief_data=brief_result.get('full_brief', {}),
                    one_liner_summary=brief_result.get('one_liner', ''),
                    meeting_date=meeting_date
                )
                
                briefs_generated += 1
                logger.info(
                    f'Brief generated and stored for meeting {meeting.get("summary", "Untitled")}',
                    userId=user_id,
                    meetingId=meeting_id
                )
            
        except Exception as error:
            logger.error(
                f'Error generating brief for meeting {meeting_id}: {str(error)}',
                userId=user_id,
                meetingId=meeting_id,
                requestId=request_id
            )
            continue
    
    return briefs_generated


@midnight_router.post('/cron/generate-midnight-briefs')
async def generate_midnight_briefs(request: Request = None):
    """
    Generate pre-prepared briefs for tomorrow's meetings
    
    Called by Railway cron job every hour
    Finds users whose local timezone is at midnight and generates briefs for them
    """
    request_id = getattr(request.state, 'request_id', 'unknown') if request else 'cron-' + datetime.now().strftime('%Y%m%d%H%M%S')
    
    logger.info('Starting daily brief generation cron job', requestId=request_id)
    
    try:
        # Get users at midnight
        users = await get_users_at_midnight()
        
        if not users:
            logger.info('No users at midnight currently', requestId=request_id)
            return {
                'success': True,
                'message': 'No users at midnight',
                'users_processed': 0,
                'briefs_generated': 0
            }
        
        logger.info(
            f'Found {len(users)} users at midnight',
            requestId=request_id,
            userEmails=[u.get('email') for u in users]
        )
        
        total_briefs = 0
        users_processed = 0
        errors = []
        
        for user in users:
            user_id = user.get('id')
            user_email = user.get('email')
            user_timezone = user.get('timezone', 'UTC')
            
            try:
                # Fetch tomorrow's meetings
                meetings = await fetch_tomorrow_meetings(user_id, user_timezone)
                
                if not meetings:
                    logger.info(f'No meetings tomorrow for user {user_email}', requestId=request_id)
                    users_processed += 1
                    continue
                
                logger.info(
                    f'Generating briefs for {len(meetings)} meetings for user {user_email}',
                    requestId=request_id
                )
                
                # Generate briefs for all meetings
                briefs_count = await generate_briefs_for_user(user, meetings, request_id)
                total_briefs += briefs_count
                users_processed += 1
                
                logger.info(
                    f'Generated {briefs_count} briefs for user {user_email}',
                    requestId=request_id
                )
                
            except Exception as user_error:
                logger.error(
                    f'Error processing user {user_email}: {str(user_error)}',
                    requestId=request_id
                )
                errors.append({
                    'user_email': user_email,
                    'error': str(user_error)
                })
                continue
        
        result = {
            'success': True,
            'message': f'Processed {users_processed} users, generated {total_briefs} briefs',
            'users_processed': users_processed,
            'briefs_generated': total_briefs,
            'timestamp': datetime.now(timezone.utc).isoformat()
        }
        
        if errors:
            result['errors'] = errors
        
        logger.info(
            'Daily brief generation completed',
            requestId=request_id,
            usersProcessed=users_processed,
            briefsGenerated=total_briefs
        )
        
        return result
        
    except Exception as error:
        logger.error(
            f'Error in daily brief generation: {str(error)}',
            requestId=request_id
        )
        raise HTTPException(
            status_code=500,
            detail={
                'error': 'CronJobError',
                'message': f'Failed to generate daily briefs: {str(error)}',
                'requestId': request_id
            }
        )

