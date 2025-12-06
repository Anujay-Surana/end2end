"""
Multi-Account Fetcher Service

Fetches emails, Drive files, and calendar events from MULTIPLE Google accounts in parallel.
This is the core of multi-account support - when a user prepares for a meeting,
we search ALL their connected accounts, not just the one where the meeting is scheduled.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any, Optional
from app.services.google_api import (
    fetch_gmail_messages,
    fetch_drive_files,
    fetch_drive_file_contents,
    fetch_calendar_events,
    parse_email_date
)
from app.services.gpt_service import call_gpt, safe_parse_json
from app.services.logger import logger


async def extract_keywords(title: str, description: str = '') -> List[str]:
    """
    Extract keywords via a single LM call (no regex heuristics).
    Returns up to 6 concise keywords.
    """
    meeting_text = f"{title or ''}\n{description or ''}".strip()
    if not meeting_text:
        return []

    try:
        response = await call_gpt([{
            'role': 'system',
            'content': (
                "Extract 3-6 short, specific keywords from the meeting title/description. "
                "Return JSON array of lowercase strings without duplicates. "
                "Omit generic words (meeting, call, sync, discuss, review) and dates/times."
            )
        }, {
            'role': 'user',
            'content': meeting_text
        }], max_tokens=150)

        parsed = safe_parse_json(response)
        if not isinstance(parsed, list):
            return []

        keywords: List[str] = []
        for item in parsed:
            kw = str(item).strip().lower()
            if kw and kw not in keywords and len(kw) <= 40:
                keywords.append(kw)
        return keywords[:6]
    except Exception as error:
        logger.warn(f'Keyword extraction via LM failed: {str(error)}')
        return []


def get_meeting_datetime(meeting: Dict[str, Any], field: str = 'start') -> Optional[str]:
    """
    Safely extract datetime string from meeting start/end field.
    Handles both dict format {'dateTime': '...'} and string format '2025-12-03'.
    
    Args:
        meeting: Meeting dict
        field: Field name ('start' or 'end')
    Returns:
        Datetime string or None
    """
    value = meeting.get(field)
    if isinstance(value, dict):
        return value.get('dateTime') or value.get('date')
    elif isinstance(value, str):
        return value
    return None


async def fetch_emails_from_all_accounts(
    accounts: List[Dict[str, Any]],
    attendees: List[Dict[str, Any]],
    meeting: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Fetch emails from all connected accounts in parallel using attendee overlap
    (excluding the account itself) and LM-extracted keywords. Single lookback
    window, bounded by meeting date.
    """
    logger.info(f'📧 Fetching emails from {len(accounts)} account(s)...')

    meeting_title = meeting.get('summary') or meeting.get('title') or ''
    keywords = await extract_keywords(meeting_title, meeting.get('description') or '')
    if keywords:
        logger.debug(f'   🔑 LM keywords: {", ".join(keywords)}')

    meeting_start = get_meeting_datetime(meeting, 'start')
    if meeting_start:
        meeting_date = datetime.fromisoformat(meeting_start.replace('Z', '+00:00'))
        if meeting_date.tzinfo is None:
            meeting_date = meeting_date.replace(tzinfo=timezone.utc)
    else:
        meeting_date = datetime.now(timezone.utc)

    meeting_cutoff = meeting_date.replace(hour=23, minute=59, second=59, microsecond=999999)
    before_date = meeting_cutoff.strftime('%Y/%m/%d')
    after_date = (meeting_date - timedelta(days=180)).strftime('%Y/%m/%d')

    async def fetch_account_emails(account: Dict[str, Any]) -> Dict[str, Any]:
        try:
            account_email = (account.get('account_email') or '').lower()

            attendee_emails = [
                (a.get('email') or a.get('emailAddress')).lower()
                for a in attendees
                if (a.get('email') or a.get('emailAddress'))
            ]
            attendee_emails = [e for e in attendee_emails if e and e != account_email]

            query_parts = []
            if attendee_emails:
                attendee_queries = ' OR '.join([f'from:{email} OR to:{email} OR cc:{email}' for email in attendee_emails])
                query_parts.append(f'({attendee_queries})')
            if keywords:
                keyword_parts = ' OR '.join([f'subject:\"{k}\" OR \"{k}\"' for k in keywords])
                query_parts.append(f'({keyword_parts})')

            if len(query_parts) == 0:
                logger.info('   ℹ️  No attendees/keywords available for email search')
                return {
                    'accountEmail': account_email,
                    'emails': [],
                    'success': True
                }

            query = f'{" OR ".join(query_parts)} after:{after_date} before:{before_date}'
            emails = await fetch_gmail_messages(account, query, 100)

            filtered_emails = []
            for email in emails:
                if not email.get('date'):
                    filtered_emails.append(email)
                    continue
                email_date = parse_email_date(email['date'])
                if email_date and email_date <= meeting_date:
                    filtered_emails.append(email)

            # Fallback: if we didn't get enough messages, pull user-sent mail in the window
            # This helps user profiling which needs >=5 sent emails.
            if len(filtered_emails) < 5 and account_email:
                fallback_query = f'from:{account_email} after:{after_date} before:{before_date}'
                fallback_emails = await fetch_gmail_messages(account, fallback_query, 50)
                for email in fallback_emails:
                    if not email.get('date'):
                        filtered_emails.append(email)
                        continue
                    email_date = parse_email_date(email['date'])
                    if email_date and email_date <= meeting_date:
                        filtered_emails.append(email)

            logger.debug(f'   ✅ Fetched {len(filtered_emails)} emails from {account_email}')

            return {
                'accountEmail': account_email,
                'emails': filtered_emails,
                'success': True
            }
        except Exception as error:
            logger.error(f'   ❌ Error fetching emails for {account.get("account_email", "unknown")}: {str(error)}')
            return {
                'accountEmail': account.get('account_email', 'unknown'),
                'emails': [],
                'success': False,
                'error': str(error)
            }

    results = await asyncio.gather(*[fetch_account_emails(acc) for acc in accounts], return_exceptions=True)

    account_stats = {
        'totalAccounts': len(accounts),
        'successfulAccounts': 0,
        'failedAccounts': [],
        'partialFailure': False
    }

    for result in results:
        if isinstance(result, Exception):
            account_stats['failedAccounts'].append({'error': str(result)})
            account_stats['partialFailure'] = True
        elif isinstance(result, dict):
            if result.get('success'):
                account_stats['successfulAccounts'] += 1
            else:
                account_stats['failedAccounts'].append({
                    'accountEmail': result.get('accountEmail'),
                    'error': result.get('error')
                })
                account_stats['partialFailure'] = True

    deduplicated_emails = merge_and_deduplicate_emails([
        r.get('emails', [])
        for r in results
        if isinstance(r, dict) and r.get('success')
    ])

    logger.info(f'✅ Fetched {len(deduplicated_emails)} unique emails from {account_stats["successfulAccounts"]} account(s)')

    return {
        'emails': deduplicated_emails,
        'accountStats': account_stats
    }


async def fetch_files_from_all_accounts(
    accounts: List[Dict[str, Any]],
    attendees: List[Dict[str, Any]],
    meeting: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Fetch Drive files from all connected accounts in parallel (ENHANCED WITH 2-YEAR LOOKBACK)
    Args:
        accounts: Array of account objects
        attendees: Meeting attendees
        meeting: Meeting object
    Returns:
        Dict with files and account stats
    """
    logger.info(f'📁 Fetching Drive files from {len(accounts)} account(s)...')

    # Extract meeting date for temporal filtering
    meeting_start = get_meeting_datetime(meeting, 'start')
    if meeting_start:
        meeting_date = datetime.fromisoformat(meeting_start.replace('Z', '+00:00'))
        # Ensure timezone-aware (if naive, assume UTC)
        if meeting_date.tzinfo is None:
            meeting_date = meeting_date.replace(tzinfo=timezone.utc)
    else:
        meeting_date = datetime.now(timezone.utc)
    
    # 2-YEAR lookback FROM MEETING DATE
    two_years_ago = meeting_date - timedelta(days=730)
    
    # Build Drive query
    attendee_emails = [
        (a.get('email') or a.get('emailAddress')).lower()
        for a in attendees
        if (a.get('email') or a.get('emailAddress'))
    ]

    async def fetch_account_files(account: Dict[str, Any]) -> Dict[str, Any]:
        try:
            account_email = (account.get('account_email') or 'unknown').lower()
            target_emails = [e for e in attendee_emails if e and e != account_email]
            
            if len(target_emails) == 0:
                return {
                    'accountEmail': account_email,
                    'files': [],
                    'success': True
                }

            # Build permission query
            perm_queries = ' or '.join([
                f"'{email}' in readers or '{email}' in writers"
                for email in target_emails
            ])
            perm_query = f'({perm_queries}) and modifiedTime > \'{two_years_ago.isoformat()}\' and modifiedTime < \'{meeting_date.isoformat()}\''

            drive_files = await fetch_drive_files(account, perm_query, 200)
            
            # Post-fetch filtering: Remove any files modified after meeting date
            drive_files = [
                f for f in drive_files
                if not f.get('modifiedTime') or datetime.fromisoformat(f['modifiedTime'].replace('Z', '+00:00')) <= meeting_date
            ]

            logger.debug(f'   ✅ Found {len(drive_files)} Drive files from {account_email}')

            # Fetch file contents
            if len(drive_files) > 0:
                files_with_content = await fetch_drive_file_contents(account, drive_files)
                return {
                    'accountEmail': account_email,
                    'files': files_with_content,
                    'success': True
                }

            return {
                'accountEmail': account_email,
                'files': [],
                'success': True
            }
        except Exception as error:
            logger.error(f'   ❌ Error fetching files for {account.get("account_email", "unknown")}: {str(error)}')
            return {
                'accountEmail': account.get('account_email', 'unknown'),
                'files': [],
                'success': False,
                'error': str(error)
            }

    # Fetch from all accounts in parallel
    results = await asyncio.gather(*[fetch_account_files(acc) for acc in accounts], return_exceptions=True)

    # Process results
    all_files = []
    account_stats = {
        'totalAccounts': len(accounts),
        'successfulAccounts': 0,
        'failedAccounts': [],
        'partialFailure': False
    }

    for result in results:
        if isinstance(result, Exception):
            account_stats['failedAccounts'].append({'error': str(result)})
            account_stats['partialFailure'] = True
        elif isinstance(result, dict):
            if result.get('success'):
                all_files.extend(result.get('files', []))
                account_stats['successfulAccounts'] += 1
            else:
                account_stats['failedAccounts'].append({
                    'accountEmail': result.get('accountEmail'),
                    'error': result.get('error')
                })
                account_stats['partialFailure'] = True

    # Deduplicate files
    deduplicated_files = merge_and_deduplicate_files([r.get('files', []) for r in results if isinstance(r, dict) and r.get('success')])

    logger.info(f'✅ Fetched {len(deduplicated_files)} unique files from {account_stats["successfulAccounts"]} account(s)')

    return {
        'files': deduplicated_files,
        'accountStats': account_stats
    }


async def fetch_calendar_from_all_accounts(
    accounts: List[Dict[str, Any]],
    attendees: List[Dict[str, Any]],
    meeting_date: datetime
) -> Dict[str, Any]:
    """
    Fetch calendar events from all connected accounts (6-month lookback),
    filtering to events that overlap with provided attendees (excluding the
    account itself).
    """
    logger.info(f'📅 Fetching calendar events from {len(accounts)} account(s)...')

    target_attendees = {
        (a.get('email') or a.get('emailAddress')).lower()
        for a in attendees
        if (a.get('email') or a.get('emailAddress'))
    }

    if meeting_date.tzinfo is None:
        meeting_date = meeting_date.replace(tzinfo=timezone.utc)

    six_months_ago = meeting_date - timedelta(days=180)
    if six_months_ago.tzinfo is None:
        six_months_ago = six_months_ago.replace(tzinfo=timezone.utc)
    
    time_min = six_months_ago.isoformat()
    time_max = meeting_date.isoformat()

    async def fetch_account_calendar(account: Dict[str, Any]) -> List[Dict[str, Any]]:
        try:
            account_email = (account.get('account_email') or '').lower()
            effective_targets = {e for e in target_attendees if e != account_email}
            if not effective_targets:
                return []

            events = await fetch_calendar_events(account, time_min, time_max, 100)

            filtered_events: List[Dict[str, Any]] = []
            for event in events:
                event_attendees = event.get('attendees') or []
                event_emails = {
                    (att.get('email') or att.get('emailAddress') or '').lower()
                    for att in event_attendees
                    if (att.get('email') or att.get('emailAddress'))
                }
                if event_emails.intersection(effective_targets):
                    filtered_events.append(event)

            return filtered_events
        except Exception as error:
            logger.error(f'   ❌ Error fetching calendar for {account.get("account_email", "unknown")}: {str(error)}')
            return []

    results = await asyncio.gather(*[fetch_account_calendar(acc) for acc in accounts], return_exceptions=True)

    all_events = []
    for result in results:
        if isinstance(result, list):
            all_events.extend(result)
        elif isinstance(result, Exception):
            logger.error(f'   ❌ Calendar fetch exception: {str(result)}')

    deduplicated_events = merge_and_deduplicate_calendar_events(all_events)

    logger.info(f'✅ Fetched {len(deduplicated_events)} unique calendar events')

    return {
        'results': deduplicated_events
    }


async def fetch_all_account_context(
    accounts: List[Dict[str, Any]],
    attendees: List[Dict[str, Any]],
    meeting: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Fetch all context (emails + files) from all accounts in parallel
    Args:
        accounts: Array of account objects
        attendees: Meeting attendees
        meeting: Meeting object
    Returns:
        Dict with emails, files, and account stats
    """
    # Fetch emails and files in parallel
    email_result, file_result = await asyncio.gather(
        fetch_emails_from_all_accounts(accounts, attendees, meeting),
        fetch_files_from_all_accounts(accounts, attendees, meeting),
        return_exceptions=True
    )

    # Handle exceptions
    if isinstance(email_result, Exception):
        logger.error(f'Email fetch failed: {str(email_result)}')
        email_result = {'emails': [], 'accountStats': {'partialFailure': True}}
    
    if isinstance(file_result, Exception):
        logger.error(f'File fetch failed: {str(file_result)}')
        file_result = {'files': [], 'accountStats': {'partialFailure': True}}

    # Merge account stats
    account_stats = {
        'totalAccounts': len(accounts),
        'successfulAccounts': min(
            email_result.get('accountStats', {}).get('successfulAccounts', 0),
            file_result.get('accountStats', {}).get('successfulAccounts', 0)
        ),
        'failedAccounts': (
            email_result.get('accountStats', {}).get('failedAccounts', []) +
            file_result.get('accountStats', {}).get('failedAccounts', [])
        ),
        'partialFailure': (
            email_result.get('accountStats', {}).get('partialFailure', False) or
            file_result.get('accountStats', {}).get('partialFailure', False)
        )
    }

    return {
        'emails': email_result.get('emails', []),
        'files': file_result.get('files', []),
        'accountStats': account_stats
    }


def merge_and_deduplicate_emails(email_results: List[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """
    Merge and deduplicate emails from multiple accounts
    Args:
        email_results: List of email arrays from different accounts
    Returns:
        Deduplicated list of emails
    """
    seen_ids = set()
    merged = []
    
    for email_list in email_results:
        for email in email_list:
            email_id = email.get('id')
            if email_id and email_id not in seen_ids:
                seen_ids.add(email_id)
                merged.append(email)
    
    return merged


def merge_and_deduplicate_files(file_results: List[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """
    Merge and deduplicate files from multiple accounts
    Args:
        file_results: List of file arrays from different accounts
    Returns:
        Deduplicated list of files
    """
    seen_ids = set()
    merged = []
    
    for file_list in file_results:
        for file in file_list:
            file_id = file.get('id')
            if file_id and file_id not in seen_ids:
                seen_ids.add(file_id)
                merged.append(file)
    
    return merged


def merge_and_deduplicate_calendar_events(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Merge and deduplicate calendar events
    Args:
        events: List of calendar events
    Returns:
        Deduplicated list of events
    """
    seen_ids = set()
    merged = []
    
    for event in events:
        event_id = event.get('id')
        if event_id and event_id not in seen_ids:
            seen_ids.add(event_id)
            merged.append(event)
    
    return merged
