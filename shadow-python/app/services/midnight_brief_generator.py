"""
Midnight Brief Generator Service

Generates meeting briefs at midnight (local time) for each user's next day meetings.
"""

import asyncio
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional
import pytz
from app.services.logger import logger
from app.db.queries.users import find_user_by_id
from app.db.queries.accounts import get_accounts_by_user_id
from app.db.queries.meeting_briefs import create_meeting_brief, get_meeting_brief
from app.services.google_api import fetch_calendar_events, ensure_valid_token
from app.services.brief_analyzer import BriefAnalyzer
from app.services.multi_account_fetcher import fetch_all_account_context
import os


async def generate_briefs_for_user(user_id: str) -> Dict[str, Any]:
    """
    Generate briefs for all of a user's meetings tomorrow
    Args:
        user_id: User UUID
    Returns:
        Dict with generation results
    """
    try:
        logger.info(f'Generating midnight briefs for user {user_id}')
        
        # Get user
        user = await find_user_by_id(user_id)
        if not user:
            logger.error(f'User not found: {user_id}')
            return {'success': False, 'error': 'User not found'}
        
        user_timezone_str = user.get('timezone', 'UTC')
        try:
            user_tz = pytz.timezone(user_timezone_str)
        except pytz.exceptions.UnknownTimeZoneError:
            logger.warn(f'Unknown timezone: {user_timezone_str}, using UTC')
            user_tz = pytz.UTC
        
        # Get tomorrow's date in user's timezone
        now_utc = datetime.now(pytz.UTC)
        now_user_tz = now_utc.astimezone(user_tz)
        tomorrow_user_tz = now_user_tz + timedelta(days=1)
        tomorrow_start = user_tz.localize(datetime.combine(tomorrow_user_tz.date(), datetime.min.time()))
        tomorrow_end = tomorrow_start + timedelta(days=1)
        
        # Convert to UTC for API calls
        tomorrow_start_utc = tomorrow_start.astimezone(pytz.UTC)
        tomorrow_end_utc = tomorrow_end.astimezone(pytz.UTC)
        
        logger.info(f'Fetching meetings for {tomorrow_start.date()} (user timezone: {user_timezone_str})')
        
        # Get user's accounts
        accounts = await get_accounts_by_user_id(user_id)
        if not accounts:
            logger.warn(f'No accounts found for user {user_id}')
            return {'success': False, 'error': 'No accounts connected'}
        
        # Validate tokens
        from app.services.google_api import ensure_all_tokens_valid
        token_result = await ensure_all_tokens_valid(accounts)
        if not token_result.get('validAccounts'):
            logger.error(f'No valid accounts for user {user_id}')
            return {'success': False, 'error': 'No valid accounts'}
        
        valid_accounts = token_result['validAccounts']
        
        # Fetch tomorrow's meetings from all accounts
        all_meetings = []
        for account in valid_accounts:
            try:
                events = await fetch_calendar_events(
                    account,
                    tomorrow_start_utc.isoformat(),
                    tomorrow_end_utc.isoformat(),
                    100
                )
                all_meetings.extend(events)
            except Exception as e:
                logger.error(f'Error fetching meetings for account {account.get("account_email")}: {str(e)}')
        
        if not all_meetings:
            logger.info(f'No meetings found for user {user_id} tomorrow')
            return {'success': True, 'briefs_generated': 0, 'meetings': []}
        
        # Filter to actual meetings (exclude all-day events, focus events, etc.)
        meetings_to_prep = []
        for meeting in all_meetings:
            # Only prep meetings with specific times (not all-day events)
            start = meeting.get('start') or meeting.get('start', {}).get('dateTime')
            if start and 'T' in start:  # Has time component
                attendees = meeting.get('attendees', [])
                # Only prep if has attendees (likely a meeting)
                if len(attendees) > 0:
                    meetings_to_prep.append(meeting)
        
        logger.info(f'Found {len(meetings_to_prep)} meetings to generate briefs for')
        
        # Generate briefs for each meeting
        openai_api_key = os.getenv('OPENAI_API_KEY')
        if not openai_api_key:
            logger.error('OPENAI_API_KEY not configured')
            return {'success': False, 'error': 'OpenAI API key not configured'}
        
        analyzer = BriefAnalyzer(openai_api_key)
        briefs_generated = 0
        errors = []
        
        for meeting in meetings_to_prep:
            meeting_id = meeting.get('id')
            if not meeting_id:
                continue
            
            # Check if brief already exists
            existing_brief = await get_meeting_brief(user_id, meeting_id)
            if existing_brief:
                logger.info(f'Brief already exists for meeting {meeting_id}, skipping')
                continue
            
            try:
                logger.info(f'Generating brief for meeting: {meeting.get("summary", "Untitled")}')
                
                # Extract attendees
                attendees = meeting.get('attendees', [])
                
                # Fetch context (emails, files, calendar events)
                context_result = await fetch_all_account_context(
                    valid_accounts,
                    attendees,
                    meeting
                )
                
                emails = context_result.get('emails', [])
                files = context_result.get('files', [])
                calendar_events = context_result.get('calendarEvents', [])
                
                # Generate brief
                context = {
                    'meeting': meeting,
                    'attendees': attendees,
                    'emails': emails,
                    'files': files,
                    'calendarEvents': calendar_events
                }
                
                brief = await analyzer.analyze(context, {'includeWebResearch': False})
                
                # Store brief
                await create_meeting_brief(user_id, meeting_id, brief)
                briefs_generated += 1
                
                logger.info(f'✓ Generated brief for meeting {meeting_id}')
                
            except Exception as e:
                error_msg = f'Error generating brief for meeting {meeting_id}: {str(e)}'
                logger.error(error_msg)
                errors.append({'meeting_id': meeting_id, 'error': str(e)})
        
        logger.info(f'Generated {briefs_generated} briefs for user {user_id}')
        
        return {
            'success': True,
            'briefs_generated': briefs_generated,
            'meetings_count': len(meetings_to_prep),
            'errors': errors
        }
        
    except Exception as e:
        logger.error(f'Error in generate_briefs_for_user: {str(e)}')
        return {'success': False, 'error': str(e)}

