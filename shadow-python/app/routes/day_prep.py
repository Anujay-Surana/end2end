"""
Day Prep Routes

Handles day prep requests - fetches all meetings for a day and prepares comprehensive day prep brief
"""

import asyncio
import json
import os
from datetime import datetime, timezone, date as date_type
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from app.middleware.auth import optional_auth
from app.db.queries.accounts import get_accounts_by_user_id
from app.db.queries.meeting_briefs import get_briefs_for_user_date, get_brief_by_meeting_id
from app.services.token_refresh import ensure_all_tokens_valid
from app.services.google_api import fetch_calendar_events
from app.services.day_prep_synthesizer import synthesize_day_prep
from app.services.calendar_event_classifier import classify_calendar_event, should_prep_event
from app.services.user_context import get_user_context
from app.services.logger import logger
from app.services.utils import get_meeting_datetime
import httpx

router = APIRouter()


@router.get('/meetings-for-day')
async def get_meetings_for_day(
    date: str = Query(..., description='Date in YYYY-MM-DD format'),
    tz: Optional[str] = Query(None, description='IANA timezone identifier (e.g., America/Los_Angeles)'),
    user: Optional[dict] = Depends(optional_auth),
    request: Request = None
):
    """
    Get all meetings for a specific day
    """
    import pytz
    from app.db.queries.users import find_user_by_id, update_user
    
    request_id = getattr(request.state, 'request_id', 'unknown') if request else 'unknown'

    if not date:
        raise HTTPException(
            status_code=400,
            detail={
                'error': 'ValidationError',
                'message': 'Date parameter is required',
                'field': 'date',
                'received': date,
                'expected': 'YYYY-MM-DD format',
                'requestId': request_id
            }
        )

    try:
        logger.info('Fetching meetings for day', requestId=request_id, date=date, clientTimezone=tz)

        # Parse date string (YYYY-MM-DD)
        try:
            year, month, day = map(int, date.split('-'))
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=400,
                detail={
                    'error': 'ValidationError',
                    'message': 'Invalid date format',
                    'field': 'date',
                    'received': date,
                    'expected': 'YYYY-MM-DD format',
                    'requestId': request_id
                }
            )

        # Determine timezone: client-provided > stored > UTC
        user_tz = pytz.UTC  # Default to UTC
        timezone_source = 'default'
        
        # First, try client-provided timezone
        if tz:
            try:
                user_tz = pytz.timezone(tz)
                timezone_source = 'client'
                logger.info(f'Using client timezone: {tz}', requestId=request_id)
                
                # Update stored timezone if user is authenticated
                if user and user.get('id'):
                    try:
                        await update_user(user['id'], {'timezone': tz})
                    except Exception as e:
                        logger.warning(f'Failed to update user timezone: {str(e)}', requestId=request_id)
            except pytz.exceptions.UnknownTimeZoneError:
                logger.warning(f'Unknown client timezone: {tz}', requestId=request_id)
        
        # If no client timezone, try stored timezone
        if timezone_source == 'default' and user and user.get('id'):
            try:
                user_data = await find_user_by_id(user['id'])
                if user_data and user_data.get('timezone'):
                    try:
                        user_tz = pytz.timezone(user_data['timezone'])
                        timezone_source = 'stored'
                        logger.info(f'Using stored timezone: {user_data["timezone"]}', requestId=request_id)
                    except pytz.exceptions.UnknownTimeZoneError:
                        logger.warning(f'Unknown stored timezone: {user_data["timezone"]}, using UTC', requestId=request_id)
            except Exception as e:
                logger.warning(f'Error fetching user timezone: {str(e)}', requestId=request_id)
        
        if timezone_source == 'default':
            logger.info('Using default timezone: UTC', requestId=request_id)

        # Create date in user's timezone, then convert to UTC for API calls
        local_start = user_tz.localize(datetime(year, month, day, 0, 0, 0))
        local_end = user_tz.localize(datetime(year, month, day, 23, 59, 59, 999999))
        
        # Convert to UTC for Google Calendar API
        start_of_day = local_start.astimezone(pytz.UTC)
        end_of_day = local_end.astimezone(pytz.UTC)
        
        logger.info(
            f'Date range: {local_start.isoformat()} to {local_end.isoformat()} (local)',
            requestId=request_id,
            utcStart=start_of_day.isoformat(),
            utcEnd=end_of_day.isoformat()
        )

        all_meetings = []

        # Multi-account mode
        if user and user.get('id'):
            accounts = await get_accounts_by_user_id(user['id'])

            if len(accounts) == 0:
                return {'meetings': []}

            # Validate tokens
            result = await ensure_all_tokens_valid(accounts)
            valid_accounts = result.get('validAccounts', [])
            failed_accounts = result.get('failedAccounts', [])

            if len(valid_accounts) == 0:
                # Check if all failures are due to revoked tokens
                all_revoked = all(f.get('isRevoked', False) for f in failed_accounts)

                raise HTTPException(
                    status_code=401,
                    detail={
                        'error': 'TokenRevoked' if all_revoked else 'AuthenticationError',
                        'message': 'Your session has expired. Please sign in again.' if all_revoked else 'All accounts need to re-authenticate',
                        'revoked': all_revoked,
                        'failedAccounts': [
                            {
                                'email': a.get('account_email'),
                                'reason': 'Token revoked' if a.get('isRevoked') else 'Token expired',
                                'isRevoked': a.get('isRevoked', False)
                            }
                            for a in failed_accounts
                        ],
                        'requestId': request_id
                    }
                )

            # Fetch meetings from all accounts in parallel
            async def fetch_account_meetings(account):
                try:
                    events = await fetch_calendar_events(
                        account,
                        start_of_day.isoformat(),
                        end_of_day.isoformat(),
                        100
                    )
                    return [{**event, 'accountEmail': account.get('account_email')} for event in events]
                except Exception as error:
                    logger.error(
                        f'Error fetching meetings for day: {str(error)}',
                        requestId=request_id,
                        accountEmail=account.get('account_email')
                    )
                    return []

            meeting_arrays = await asyncio.gather(*[fetch_account_meetings(acc) for acc in valid_accounts])
            all_meetings = [m for arr in meeting_arrays for m in arr]
            
            # Extract and update timezone from calendar events if user is authenticated
            if user and user.get('id'):
                try:
                    from app.db.queries.users import extract_and_update_timezone_from_calendar
                    await extract_and_update_timezone_from_calendar(user.get('id'), all_meetings)
                except Exception as e:
                    logger.warning(f'Failed to extract timezone from calendar: {str(e)}', requestId=request_id)

        else:
            # Single-account mode (backward compatibility)
            auth_header = request.headers.get('authorization') if request else None
            access_token = auth_header.replace('Bearer ', '') if auth_header and auth_header.startswith('Bearer ') else None

            if not access_token:
                raise HTTPException(
                    status_code=401,
                    detail={
                        'error': 'AuthenticationError',
                        'message': 'Access token required',
                        'requestId': request_id
                    }
                )

            events = await fetch_calendar_events(
                access_token,
                start_of_day.isoformat(),
                end_of_day.isoformat(),
                100
            )
            all_meetings = events
            
            # Extract and update timezone from calendar events if user is authenticated
            if user and user.get('id'):
                try:
                    from app.db.queries.users import extract_and_update_timezone_from_calendar
                    await extract_and_update_timezone_from_calendar(user.get('id'), all_meetings)
                except Exception as e:
                    logger.warning(f'Failed to extract timezone from calendar: {str(e)}', requestId=request_id)

        # Classify events and add classification metadata
        user_context = await get_user_context(user, request_id) if user else None
        user_email = user_context.get('email') if user_context else (user.get('email') if user else '')
        user_emails = user_context.get('emails', []) if user_context else []
        
        classified_meetings = []
        for meeting in all_meetings:
            classification = classify_calendar_event(meeting, user_email, user_emails)
            meeting['_classification'] = classification
            classified_meetings.append(meeting)
        
        # Sort by start time
        def get_start_time(meeting):
            start = meeting.get('start', {})
            # Handle both dict and string formats
            if isinstance(start, dict):
                return start.get('dateTime') or start.get('date') or ''
            elif isinstance(start, str):
                return start
            return ''

        classified_meetings.sort(key=lambda m: get_start_time(m) or '0')
        
        # Fetch pre-generated briefs for this date
        briefs_map = {}
        if user and user.get('id'):
            try:
                # Parse date string to date object
                year, month, day = map(int, date.split('-'))
                meeting_date = date_type(year, month, day)
                
                # Get all briefs for this user and date
                briefs = await get_briefs_for_user_date(user['id'], meeting_date)
                
                # Create a map of meeting_id -> brief data
                for brief in briefs:
                    # Get timestamp - try multiple field names for compatibility
                    generated_at = (
                        brief.get('updated_at') or 
                        brief.get('created_at') or 
                        brief.get('generated_at')
                    )
                    
                    one_liner = brief.get('one_liner_summary', '')
                    meeting_id = brief.get('meeting_id')
                    
                    # Debug logging to trace brief data
                    logger.info(
                        f'Brief data for meeting {meeting_id}: one_liner="{one_liner[:50] if one_liner else "EMPTY"}", generated_at={generated_at}',
                        requestId=request_id
                    )
                    
                    briefs_map[meeting_id] = {
                        'one_liner': one_liner,
                        'brief_ready': True,
                        'generated_at': generated_at,
                        # Include full brief data for attendee info, document analysis, etc.
                        'brief_data': brief.get('brief_data', {})
                    }
                
                logger.info(
                    f'Found {len(briefs)} pre-generated briefs for date {date}',
                    requestId=request_id,
                    userId=user['id']
                )
            except Exception as brief_error:
                logger.warning(
                    f'Error fetching briefs: {str(brief_error)}',
                    requestId=request_id
                )
        
        # Add brief data to each meeting
        # Debug: log all meeting IDs and briefs_map keys
        logger.info(f'briefs_map keys: {list(briefs_map.keys())}', requestId=request_id)
        
        for meeting in classified_meetings:
            meeting_id = meeting.get('id')
            logger.info(f'Checking meeting_id={meeting_id}, in briefs_map={meeting_id in briefs_map}', requestId=request_id)
            
            if meeting_id and meeting_id in briefs_map:
                brief_to_attach = briefs_map[meeting_id]
                logger.info(f'Attaching brief to {meeting_id}: one_liner={brief_to_attach.get("one_liner", "")[:30] if brief_to_attach.get("one_liner") else "NONE"}', requestId=request_id)
                meeting['_brief'] = brief_to_attach
            else:
                meeting['_brief'] = {
                    'one_liner': None,
                    'brief_ready': False,
                    'generated_at': None
                }
        
        # Count meetings vs non-meetings
        meetings_count = sum(1 for m in classified_meetings if m['_classification']['type'] == 'meeting')
        non_meetings_count = len(classified_meetings) - meetings_count
        briefs_ready_count = sum(1 for m in classified_meetings if m.get('_brief', {}).get('brief_ready'))

        logger.info(
            'Meetings fetched for day',
            requestId=request_id,
            date=date,
            meetingCount=meetings_count,
            totalEvents=len(classified_meetings),
            nonMeetings=non_meetings_count,
            briefsReady=briefs_ready_count
        )

        return {'meetings': classified_meetings}

    except HTTPException:
        raise
    except Exception as error:
        logger.error(
            f'Error fetching meetings for day: {str(error)}',
            requestId=request_id,
            date=date
        )
        raise HTTPException(
            status_code=500,
            detail={
                'error': 'ServerError',
                'message': 'Failed to fetch meetings for day',
                'requestId': request_id
            }
        )


@router.post('/day-prep')
async def day_prep(
    date: str,
    user: Optional[dict] = Depends(optional_auth),
    request: Request = None
):
    """
    Prepare comprehensive day prep for all meetings on a specific day
    """
    request_id = getattr(request.state, 'request_id', 'unknown') if request else 'unknown'

    if not date:
        raise HTTPException(
            status_code=400,
            detail={
                'error': 'ValidationError',
                'message': 'Date is required',
                'field': 'date',
                'received': date,
                'expected': 'YYYY-MM-DD format',
                'requestId': request_id
            }
        )

    try:
        logger.info('Starting day prep', requestId=request_id, date=date)

        # Parse date
        try:
            selected_date = datetime.fromisoformat(date)
            if selected_date.year < 2000:
                raise ValueError('Invalid date')
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=400,
                detail={
                    'error': 'ValidationError',
                    'message': 'Invalid date format',
                    'field': 'date',
                    'received': date,
                    'expected': 'YYYY-MM-DD format',
                    'requestId': request_id
                }
            )

        # Set time boundaries for the day
        start_of_day = selected_date.replace(hour=0, minute=0, second=0, microsecond=0)
        end_of_day = selected_date.replace(hour=23, minute=59, second=59, microsecond=999999)

        # Fetch meetings for the day
        all_meetings = []

        if user and user.get('id'):
            accounts = await get_accounts_by_user_id(user['id'])

            if len(accounts) == 0:
                raise HTTPException(
                    status_code=401,
                    detail={
                        'error': 'AuthenticationError',
                        'message': 'No connected accounts',
                        'requestId': request_id
                    }
                )

            result = await ensure_all_tokens_valid(accounts)
            valid_accounts = result.get('validAccounts', [])

            if len(valid_accounts) == 0:
                raise HTTPException(
                    status_code=401,
                    detail={
                        'error': 'AuthenticationError',
                        'message': 'All accounts need to re-authenticate',
                        'requestId': request_id
                    }
                )

            async def fetch_account_meetings(account):
                try:
                    events = await fetch_calendar_events(
                        account,
                        start_of_day.isoformat(),
                        end_of_day.isoformat(),
                        100
                    )
                    return events
                except Exception as error:
                    logger.error(
                        f'Error fetching meetings for day prep: {str(error)}',
                        requestId=request_id,
                        accountEmail=account.get('account_email')
                    )
                    return []

            meeting_arrays = await asyncio.gather(*[fetch_account_meetings(acc) for acc in valid_accounts])
            all_meetings = [m for arr in meeting_arrays for m in arr]

        else:
            raise HTTPException(
                status_code=401,
                detail={
                    'error': 'AuthenticationError',
                    'message': 'Authentication required for day prep',
                    'requestId': request_id
                }
            )

        if len(all_meetings) == 0:
            date_str = selected_date.strftime('%A, %B %d, %Y')
            return {
                'success': True,
                'dayPrep': {
                    'date': date,
                    'summary': f'No meetings scheduled for {date_str}.',
                    'meetings': [],
                    'prep': []
                }
            }

        # Sort meetings by time
        def get_start_time(meeting):
            start = meeting.get('start', {})
            # Handle both dict and string formats
            if isinstance(start, dict):
                return start.get('dateTime') or start.get('date') or ''
            elif isinstance(start, str):
                return start
            return ''

        all_meetings.sort(key=lambda m: get_start_time(m) or '0')

        logger.info('Preparing day prep for meetings', requestId=request_id, date=date, meetingCount=len(all_meetings))

        # Run meeting prep on all meetings in PARALLEL
        # Make internal HTTP calls to prep-meeting endpoint
        async def prep_meeting(meeting):
            try:
                async with httpx.AsyncClient() as client:
                    # Get base URL from request or use default
                    base_url = f"http://localhost:{os.getenv('PORT', '8080')}"
                    if request:
                        base_url = f"{request.url.scheme}://{request.url.netloc}"

                    cookies = request.cookies if request else {}
                    headers = {'Content-Type': 'application/json'}
                    if cookies:
                        headers['Cookie'] = '; '.join([f"{k}={v}" for k, v in cookies.items()])

                    # Prep-meeting now returns streaming NDJSON, so we need to read it chunk by chunk
                    async with client.stream(
                        'POST',
                        f'{base_url}/api/prep-meeting',
                        json={
                            'meeting': meeting,
                            'attendees': meeting.get('attendees', [])
                        },
                        headers=headers,
                        timeout=300.0
                    ) as response:
                        if not response.is_success:
                            error_text = await response.aread()
                            raise Exception(f'Prep meeting failed: {response.status_code} - {error_text.decode()[:200]}')
                        
                        # Read streaming NDJSON response
                        brief = None
                        async for line in response.aiter_lines():
                            if not line.strip():
                                continue
                            try:
                                chunk = json.loads(line)
                                if chunk.get('type') == 'complete':
                                    # Remove 'type' field and use rest as brief
                                    brief = {k: v for k, v in chunk.items() if k != 'type'}
                                    break
                                elif chunk.get('type') == 'error':
                                    error_msg = chunk.get('message') or chunk.get('error', 'Unknown error')
                                    raise Exception(f'Prep meeting error: {error_msg}')
                            except json.JSONDecodeError:
                                continue
                        
                        if brief:
                            return {'meeting': meeting, 'brief': brief, 'success': True}
                        else:
                            raise Exception('No complete result received from prep-meeting')
            except Exception as error:
                logger.error(
                    f'Error preparing meeting for day prep: {str(error)}',
                    requestId=request_id,
                    meetingId=meeting.get('id')
                )
                return {'meeting': meeting, 'brief': None, 'success': False, 'error': str(error)}

        prep_results = await asyncio.gather(*[prep_meeting(m) for m in all_meetings])
        successful_preps = [r for r in prep_results if r.get('success') and r.get('brief')]

        logger.info(
            'Day prep meetings prepared',
            requestId=request_id,
            totalMeetings=len(all_meetings),
            successfulPreps=len(successful_preps)
        )

        # Synthesize day prep using Shadow persona
        day_prep_result = await synthesize_day_prep(
            selected_date,
            all_meetings,
            [r['brief'] for r in successful_preps],
            request_id,
            user
        )

        # Format response to match mobile app expectations
        # Mobile expects: { success: bool, dayPrep: { date, summary, meetings[], prep?[] } }
        return {
            'success': True,
            'dayPrep': {
                'date': date,
                'summary': day_prep_result.get('summary', ''),
                'meetings': [
                    {
                        'id': m.get('id'),
                        'summary': m.get('summary') or m.get('title'),
                        'title': m.get('title'),
                        'description': m.get('description'),
                        'start': m.get('start'),
                        'end': m.get('end'),
                        'attendees': m.get('attendees', []),
                        'location': m.get('location'),
                        'htmlLink': m.get('htmlLink'),
                        'accountEmail': m.get('accountEmail')
                    }
                    for m in all_meetings
                ],
                'prep': [
                    {
                        'meetingTitle': r['meeting'].get('summary') or r['meeting'].get('title'),
                        'meetingDate': get_meeting_datetime(r['meeting'], 'start'),
                        'summary': r['brief'].get('summary') if r.get('brief') else '',
                        'sections': []  # Can be populated if needed
                    }
                    for r in successful_preps
                    if r.get('brief')
                ]
            }
        }

    except HTTPException:
        raise
    except Exception as error:
        logger.error(
            f'Error preparing day prep: {str(error)}',
            requestId=request_id,
            date=date
        )
        raise HTTPException(
            status_code=500,
            detail={
                'error': 'ServerError',
                'message': 'Failed to prepare day prep',
                'requestId': request_id
            }
        )
