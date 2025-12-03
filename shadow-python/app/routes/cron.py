"""
Cron Routes - Hourly Brief Generation

Generates briefs for meetings starting in the next hour
Triggered by Railway cron job every hour

RAILWAY CRON CONFIGURATION:
==========================
Schedule: 0 * * * * (every hour at minute 0)
Endpoint: POST /api/cron/generate-hourly-briefs

See cron_midnight.py for the midnight-based full-day approach.
"""

import asyncio
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, Request, HTTPException
import pytz

from app.services.logger import logger
from app.db.connection import supabase
from app.db.queries.accounts import get_accounts_by_user_id
from app.db.queries.meeting_briefs import upsert_meeting_brief, get_brief_by_meeting_id
from app.services.token_refresh import ensure_all_tokens_valid
from app.services.google_api import fetch_calendar_events
from app.services.brief_generator import generate_brief_with_one_liner

router = APIRouter()


async def get_all_users() -> List[Dict[str, Any]]:
    """
    Get all users from the database
    """
    try:
        response = supabase.table('users').select('id, email, timezone').execute()
        
        if hasattr(response, 'error') and response.error:
            logger.error(f'Failed to fetch users: {response.error.message}')
            return []
        
        return response.data or []
        
    except Exception as error:
        logger.error(f'Error getting users: {str(error)}')
        return []


async def fetch_upcoming_hour_meetings(user_id: str, user_timezone: str) -> List[Dict[str, Any]]:
    """
    Fetch calendar meetings starting in the next 60-90 minutes
    This gives users ~1 hour prep time before the meeting
    """
    try:
        # Get user's accounts
        accounts = await get_accounts_by_user_id(user_id)
        if not accounts:
            return []
        
        # Validate tokens
        token_result = await ensure_all_tokens_valid(accounts)
        valid_accounts = token_result.get('validAccounts', [])
        
        if not valid_accounts:
            return []
        
        # Get meetings starting between now+60min and now+90min
        # This 30-minute window ensures we catch meetings without duplicating
        now_utc = datetime.now(timezone.utc)
        start_window = now_utc + timedelta(minutes=60)
        end_window = now_utc + timedelta(minutes=90)
        
        logger.info(
            f'Fetching meetings for user {user_id}',
            startWindow=start_window.isoformat(),
            endWindow=end_window.isoformat()
        )
        
        all_meetings = []
        
        async def fetch_account_meetings(account):
            try:
                events = await fetch_calendar_events(
                    account,
                    start_window.isoformat(),
                    end_window.isoformat(),
                    50
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
        
        return all_meetings
        
    except Exception as error:
        logger.error(f'Error fetching upcoming meetings for user {user_id}: {str(error)}')
        return []


async def generate_brief_for_meeting(
    user: Dict[str, Any],
    meeting: Dict[str, Any],
    request_id: str
) -> bool:
    """
    Generate a brief for a single meeting
    Returns True if brief was generated, False otherwise
    """
    user_id = user.get('id')
    meeting_id = meeting.get('id')
    
    if not meeting_id:
        return False
    
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
                    meeting_date = datetime.now(timezone.utc).date()
            else:
                meeting_date = datetime.now(timezone.utc).date()
            
            # Store brief in database
            await upsert_meeting_brief(
                user_id=user_id,
                meeting_id=meeting_id,
                brief_data=brief_result.get('full_brief', {}),
                one_liner_summary=brief_result.get('one_liner', ''),
                meeting_date=meeting_date
            )
            
            logger.info(
                f'Brief generated and stored for meeting {meeting.get("summary", "Untitled")}',
                userId=user_id,
                meetingId=meeting_id
            )
            return True
        
        return False
        
    except Exception as error:
        logger.error(
            f'Error generating brief for meeting {meeting_id}: {str(error)}',
            userId=user_id,
            meetingId=meeting_id,
            requestId=request_id
        )
        return False


@router.post('/cron/generate-hourly-briefs')
async def generate_hourly_briefs(request: Request = None):
    """
    Generate briefs for meetings starting in the next hour
    
    Called by Railway cron job every hour
    Checks ALL users for meetings starting in 60-90 minutes
    Skips meetings that already have briefs
    """
    request_id = getattr(request.state, 'request_id', 'unknown') if request else 'cron-hourly-' + datetime.now().strftime('%Y%m%d%H%M%S')
    
    logger.info('Starting hourly brief generation cron job', requestId=request_id)
    
    try:
        # Get all users
        users = await get_all_users()
        
        if not users:
            logger.info('No users found', requestId=request_id)
            return {
                'success': True,
                'message': 'No users found',
                'users_checked': 0,
                'briefs_generated': 0
            }
        
        logger.info(f'Checking {len(users)} users for upcoming meetings', requestId=request_id)
        
        total_briefs = 0
        users_with_meetings = 0
        meetings_skipped = 0
        errors = []
        
        for user in users:
            user_id = user.get('id')
            user_email = user.get('email')
            user_timezone = user.get('timezone', 'UTC')
            
            try:
                # Fetch meetings in the next hour
                meetings = await fetch_upcoming_hour_meetings(user_id, user_timezone)
                
                if not meetings:
                    continue
                
                users_with_meetings += 1
                
                logger.info(
                    f'Found {len(meetings)} upcoming meetings for user {user_email}',
                    requestId=request_id
                )
                
                # Generate briefs only for meetings that don't already have one
                for meeting in meetings:
                    meeting_id = meeting.get('id')
                    
                    # Check if brief already exists
                    existing = await get_brief_by_meeting_id(user_id, meeting_id)
                    if existing:
                        meetings_skipped += 1
                        logger.info(
                            f'Skipping meeting {meeting.get("summary", "Untitled")} - brief already exists',
                            requestId=request_id
                        )
                        continue
                    
                    # Generate brief
                    success = await generate_brief_for_meeting(user, meeting, request_id)
                    if success:
                        total_briefs += 1
                
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
            'message': f'Generated {total_briefs} briefs for {users_with_meetings} users with upcoming meetings',
            'users_checked': len(users),
            'users_with_meetings': users_with_meetings,
            'briefs_generated': total_briefs,
            'meetings_skipped': meetings_skipped,
            'timestamp': datetime.now(timezone.utc).isoformat()
        }
        
        if errors:
            result['errors'] = errors
        
        logger.info(
            'Hourly brief generation completed',
            requestId=request_id,
            usersChecked=len(users),
            usersWithMeetings=users_with_meetings,
            briefsGenerated=total_briefs,
            meetingsSkipped=meetings_skipped
        )
        
        return result
        
    except Exception as error:
        logger.error(
            f'Error in hourly brief generation: {str(error)}',
            requestId=request_id
        )
        raise HTTPException(
            status_code=500,
            detail={
                'error': 'CronJobError',
                'message': f'Failed to generate hourly briefs: {str(error)}',
                'requestId': request_id
            }
        )


# Also expose the midnight endpoint for backwards compatibility
# Import from cron_midnight if needed
@router.post('/cron/generate-daily-briefs')
async def generate_daily_briefs(request: Request = None):
    """
    Redirect to hourly briefs for now
    For the original midnight-based approach, see cron_midnight.py
    """
    return await generate_hourly_briefs(request)

