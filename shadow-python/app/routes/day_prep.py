"""
Day Prep Routes

Handles day prep requests - fetches all meetings for a day and prepares comprehensive day prep brief
"""

import asyncio
import os
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from app.middleware.auth import optional_auth
from app.db.queries.accounts import get_accounts_by_user_id
from app.services.token_refresh import ensure_all_tokens_valid
from app.services.google_api import fetch_calendar_events
from app.services.day_prep_synthesizer import synthesize_day_prep
from app.services.calendar_event_classifier import classify_calendar_event, should_prep_event
from app.services.user_context import get_user_context
from app.services.logger import logger
import httpx

router = APIRouter()


@router.get('/meetings-for-day')
async def get_meetings_for_day(
    date: str = Query(..., description='Date in YYYY-MM-DD format'),
    user: Optional[dict] = Depends(optional_auth),
    request: Request = None
):
    """
    Get all meetings for a specific day
    """
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
        logger.info('Fetching meetings for day', requestId=request_id, date=date)

        # Parse date string (YYYY-MM-DD) - create date at midnight in UTC
        try:
            year, month, day = map(int, date.split('-'))
            selected_date = datetime(year, month, day, tzinfo=timezone.utc)  # Creates date in UTC
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

        # Set time boundaries for the day (UTC-aware for RFC3339 format)
        start_of_day = selected_date.replace(hour=0, minute=0, second=0, microsecond=0)
        end_of_day = selected_date.replace(hour=23, minute=59, second=59, microsecond=999999)

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
        
        # Count meetings vs non-meetings
        meetings_count = sum(1 for m in classified_meetings if m['_classification']['type'] == 'meeting')
        non_meetings_count = len(classified_meetings) - meetings_count

        logger.info(
            'Meetings fetched for day',
            requestId=request_id,
            date=date,
            meetingCount=meetings_count,
            totalEvents=len(classified_meetings),
            nonMeetings=non_meetings_count
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
                'date': date,
                'meetings': [],
                'dayPrep': {
                    'summary': f'No meetings scheduled for {date_str}.',
                    'narrative': 'You have no meetings scheduled for this day.'
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

                    response = await client.post(
                        f'{base_url}/api/prep-meeting',
                        json={
                            'meeting': meeting,
                            'attendees': meeting.get('attendees', [])
                        },
                        headers=headers,
                        timeout=300.0
                    )

                    if response.is_success:
                        brief = response.json()
                        return {'meeting': meeting, 'brief': brief, 'success': True}
                    else:
                        error_text = response.text[:200]
                        raise Exception(f'Prep meeting failed: {response.status_code} - {error_text}')
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

        return {
            'date': date,
            'meetings': [
                {
                    'id': m.get('id'),
                    'summary': m.get('summary') or m.get('title'),
                    'start': m.get('start'),
                    'attendees': m.get('attendees', [])
                }
                for m in all_meetings
            ],
            'prepResults': [
                {
                    'meetingId': r['meeting'].get('id'),
                    'success': r.get('success'),
                    'error': r.get('error')
                }
                for r in prep_results
            ],
            'dayPrep': day_prep_result
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
