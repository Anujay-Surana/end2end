"""
Notification Dispatcher Service

Handles sending meeting reminders and other notifications
"""

import asyncio
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional
import pytz
from app.services.logger import logger
from app.db.queries.users import find_user_by_id
from app.db.queries.accounts import get_accounts_by_user_id
from app.db.queries.devices import get_user_devices
from app.db.queries.meeting_briefs import get_meeting_brief
from app.db.connection import supabase
from app.services.google_api import fetch_calendar_events, ensure_all_tokens_valid
from app.services.apns_service import get_apns_service


async def send_meeting_reminders(user_id: str, user_timezone_str: str = 'UTC') -> Dict[str, Any]:
    """
    Check for meetings starting in 15 minutes and send reminders
    Args:
        user_id: User UUID
        user_timezone_str: User's timezone string
    Returns:
        Dict with results
    """
    try:
        # Get user's timezone
        try:
            user_tz = pytz.timezone(user_timezone_str)
        except pytz.exceptions.UnknownTimeZoneError:
            logger.warn(f'Unknown timezone: {user_timezone_str}, using UTC')
            user_tz = pytz.UTC
        
        # Get current time in user's timezone
        now_utc = datetime.now(pytz.UTC)
        now_user_tz = now_utc.astimezone(user_tz)
        
        # Calculate 15 minutes from now
        reminder_time = now_user_tz + timedelta(minutes=15)
        reminder_window_start = reminder_time.replace(second=0, microsecond=0)
        reminder_window_end = reminder_window_start + timedelta(minutes=1)
        
        # Convert to UTC for API calls
        reminder_start_utc = reminder_window_start.astimezone(pytz.UTC)
        reminder_end_utc = reminder_window_end.astimezone(pytz.UTC)
        
        # Get user's accounts
        accounts = await get_accounts_by_user_id(user_id)
        if not accounts:
            return {'success': True, 'reminders_sent': 0}
        
        # Validate tokens
        token_result = await ensure_all_tokens_valid(accounts)
        if not token_result.get('validAccounts'):
            return {'success': True, 'reminders_sent': 0}
        
        valid_accounts = token_result['validAccounts']
        
        # Fetch meetings in the reminder window
        all_meetings = []
        for account in valid_accounts:
            try:
                events = await fetch_calendar_events(
                    account,
                    reminder_start_utc.isoformat(),
                    reminder_end_utc.isoformat(),
                    100
                )
                all_meetings.extend(events)
            except Exception as e:
                logger.error(f'Error fetching meetings for reminder: {str(e)}')
        
        if not all_meetings:
            return {'success': True, 'reminders_sent': 0}
        
        # Filter to actual meetings
        meetings_to_remind = []
        for meeting in all_meetings:
            start = meeting.get('start') or meeting.get('start', {}).get('dateTime')
            if start and 'T' in start:  # Has time component
                attendees = meeting.get('attendees', [])
                if len(attendees) > 0:
                    meetings_to_remind.append(meeting)
        
        if not meetings_to_remind:
            return {'success': True, 'reminders_sent': 0}
        
        # Get user's devices
        devices = await get_user_devices(user_id)
        if not devices:
            return {'success': True, 'reminders_sent': 0, 'devices': 0}
        
        apns_service = get_apns_service()
        if not apns_service.is_configured():
            return {'success': True, 'reminders_sent': 0, 'apns_configured': False}
        
        # Send reminders for each meeting
        reminders_sent = 0
        for meeting in meetings_to_remind:
            meeting_id = meeting.get('id')
            meeting_title = meeting.get('summary', 'Untitled Meeting')
            
            # Format meeting time
            start_time = meeting.get('start', {}).get('dateTime', '') or meeting.get('start', '')
            try:
                if 'T' in start_time:
                    dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                    time_str = dt.astimezone(user_tz).strftime('%I:%M %p')
                else:
                    time_str = 'All day'
            except:
                time_str = start_time
            
            # Send push notification to all devices
            for device in devices:
                device_token = device.get('device_token')
                if not device_token:
                    continue
                
                result = await apns_service.send_notification(
                    device_token=device_token,
                    title='Meeting Reminder',
                    body=f"Your meeting '{meeting_title}' starts in 15 min. Prep now?",
                    data={
                        'type': 'meeting_reminder',
                        'meeting_id': meeting_id,
                        'meeting_title': meeting_title,
                        'start_time': start_time
                    },
                    sound='default'
                )
                
                if result.get('success'):
                    reminders_sent += 1
                    
                    # Store chat message
                    try:
                        from app.db.queries.chat_messages import create_chat_message
                        await create_chat_message(
                            user_id=user_id,
                            role='system',
                            content=f"Reminder: Your meeting '{meeting_title}' starts at {time_str}.",
                            meeting_id=meeting_id
                        )
                    except Exception as e:
                        logger.error(f'Error storing reminder message: {str(e)}')
        
        if reminders_sent > 0:
            logger.info(f'Sent {reminders_sent} meeting reminder(s) for user {user_id}')
        
        return {
            'success': True,
            'reminders_sent': reminders_sent,
            'meetings_count': len(meetings_to_remind)
        }
        
    except Exception as e:
        logger.error(f'Error in send_meeting_reminders: {str(e)}')
        return {'success': False, 'error': str(e)}

