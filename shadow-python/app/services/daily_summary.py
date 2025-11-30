"""
Daily Summary Service

Generates and sends daily summary at 9 AM (local time) for each user.
"""

import asyncio
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional
import pytz
from app.services.logger import logger
from app.db.queries.users import find_user_by_id
from app.db.queries.accounts import get_accounts_by_user_id
from app.db.queries.devices import get_user_devices
from app.db.queries.chat_messages import create_chat_message
from app.db.queries.meeting_briefs import get_user_briefs
from app.services.google_api import fetch_calendar_events
from app.services.token_refresh import ensure_all_tokens_valid
from app.services.apns_service import get_apns_service
from app.db.connection import supabase


async def send_daily_summary_for_user(user_id: str) -> Dict[str, Any]:
    """
    Send daily summary for a user at 9 AM
    Args:
        user_id: User UUID
    Returns:
        Dict with results
    """
    try:
        logger.info(f'Sending daily summary for user {user_id}')
        
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
        
        # Get today's date in user's timezone
        now_utc = datetime.now(pytz.UTC)
        now_user_tz = now_utc.astimezone(user_tz)
        today_start = user_tz.localize(datetime.combine(now_user_tz.date(), datetime.min.time()))
        today_end = today_start + timedelta(days=1)
        
        # Convert to UTC for API calls
        today_start_utc = today_start.astimezone(pytz.UTC)
        today_end_utc = today_end.astimezone(pytz.UTC)
        
        # Get user's accounts
        accounts = await get_accounts_by_user_id(user_id)
        if not accounts:
            logger.warn(f'No accounts found for user {user_id}')
            return {'success': False, 'error': 'No accounts connected'}
        
        # Validate tokens
        token_result = await ensure_all_tokens_valid(accounts)
        if not token_result.get('validAccounts'):
            logger.error(f'No valid accounts for user {user_id}')
            return {'success': False, 'error': 'No valid accounts'}
        
        valid_accounts = token_result['validAccounts']
        
        # Fetch today's meetings
        all_meetings = []
        for account in valid_accounts:
            try:
                events = await fetch_calendar_events(
                    account,
                    today_start_utc.isoformat(),
                    today_end_utc.isoformat(),
                    100
                )
                all_meetings.extend(events)
            except Exception as e:
                logger.error(f'Error fetching meetings for account {account.get("account_email")}: {str(e)}')
        
        # Filter to actual meetings
        meetings = []
        for meeting in all_meetings:
            start = meeting.get('start') or meeting.get('start', {}).get('dateTime')
            if start and 'T' in start:  # Has time component
                attendees = meeting.get('attendees', [])
                if len(attendees) > 0:
                    meetings.append(meeting)
        
        # Sort by start time
        meetings.sort(key=lambda m: m.get('start', {}).get('dateTime', '') or m.get('start', ''))
        
        # Generate summary message
        if len(meetings) == 0:
            summary_text = "You have no meetings scheduled for today. Enjoy your free day!"
        elif len(meetings) == 1:
            meeting = meetings[0]
            title = meeting.get('summary', 'Untitled Meeting')
            start_time = meeting.get('start', {}).get('dateTime', '') or meeting.get('start', '')
            # Format time
            try:
                if 'T' in start_time:
                    dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                    time_str = dt.astimezone(user_tz).strftime('%I:%M %p')
                else:
                    time_str = 'All day'
            except:
                time_str = start_time
            
            summary_text = f"You have 1 meeting today:\n\n1. {title} – {time_str}"
        else:
            summary_lines = [f"You have {len(meetings)} meetings today:\n"]
            for i, meeting in enumerate(meetings, 1):
                title = meeting.get('summary', 'Untitled Meeting')
                start_time = meeting.get('start', {}).get('dateTime', '') or meeting.get('start', '')
                # Format time
                try:
                    if 'T' in start_time:
                        dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                        time_str = dt.astimezone(user_tz).strftime('%I:%M %p')
                    else:
                        time_str = 'All day'
                except:
                    time_str = start_time
                
                summary_lines.append(f"{i}. {title} – {time_str}")
            
            summary_text = "\n".join(summary_lines)
        
        # Store chat message
        try:
            await create_chat_message(
                user_id=user_id,
                role='assistant',
                content=summary_text
            )
        except Exception as e:
            logger.error(f'Error storing chat message: {str(e)}')
        
        # Send push notification to all user's devices
        devices = await get_user_devices(user_id)
        if not devices:
            logger.info(f'No devices registered for user {user_id}, skipping push notification')
            return {'success': True, 'message_sent': False, 'devices': 0}
        
        apns_service = get_apns_service()
        if not apns_service.is_configured():
            logger.warn('APNs not configured, skipping push notification')
            return {'success': True, 'message_sent': False, 'push_sent': False}
        
        # Send push notifications
        notifications_sent = 0
        for device in devices:
            device_token = device.get('device_token')
            if not device_token:
                continue
            
            result = await apns_service.send_notification(
                device_token=device_token,
                title='Your Daily Summary',
                body=f"You have {len(meetings)} meeting{'s' if len(meetings) != 1 else ''} today." if meetings else "You have no meetings today.",
                data={
                    'type': 'daily_summary',
                    'meetings_count': len(meetings)
                },
                sound='default'
            )
            
            if result.get('success'):
                notifications_sent += 1
        
        logger.info(f'Sent daily summary to {notifications_sent} device(s) for user {user_id}')
        
        return {
            'success': True,
            'message_sent': True,
            'push_sent': notifications_sent > 0,
            'devices': len(devices),
            'notifications_sent': notifications_sent,
            'meetings_count': len(meetings)
        }
        
    except Exception as e:
        logger.error(f'Error in send_daily_summary_for_user: {str(e)}')
        return {'success': False, 'error': str(e)}

