"""
Multi-Account Fetcher Service

Fetches emails, Drive files, and calendar events from MULTIPLE Google accounts in parallel.
This is the core of multi-account support - when a user prepares for a meeting,
we search ALL their connected accounts, not just the one where the meeting is scheduled.
"""

import asyncio
import re
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any, Optional
from app.services.google_api import (
    fetch_gmail_messages,
    fetch_drive_files,
    fetch_drive_file_contents,
    fetch_calendar_events,
    parse_email_date
)
from app.services.logger import logger


def extract_keywords(title: str, description: str = '') -> List[str]:
    """
    Extract keywords from meeting title and description
    Args:
        title: Meeting title
        description: Meeting description
    Returns:
        List of keywords (max 5)
    """
    text = f"{title} {description}".lower()
    stop_words = {
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
        'meeting', 'discussion', 'call', 'review', 'session', 'sync', 'chat', 'talk'
    }

    words = [
        w for w in re.split(r'[\s\-_,\.;:()[\]{}]+', text)
        if len(w) > 3 and w not in stop_words and not re.match(r'^\d+$', w)
    ]

    # Return unique words, max 5
    return list(dict.fromkeys(words))[:5]


async def fetch_emails_from_all_accounts(
    accounts: List[Dict[str, Any]],
    attendees: List[Dict[str, Any]],
    meeting: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Fetch emails from all connected accounts in parallel (ENHANCED WITH 2-YEAR LOOKBACK + KEYWORDS)
    Args:
        accounts: Array of account objects with access_token
        attendees: Meeting attendees
        meeting: Meeting object
    Returns:
        Dict with emails and account stats
    """
    logger.info(f'📧 Fetching emails from {len(accounts)} account(s)...')

    # Extract keywords from meeting title for enhanced search
    meeting_title = meeting.get('summary') or meeting.get('title') or ''
    keywords = extract_keywords(meeting_title, meeting.get('description') or '')
    if keywords:
        logger.debug(f'   🔑 Extracted keywords: {", ".join(keywords)}')

    # Extract meeting date for temporal filtering (only use data BEFORE meeting)
    meeting_start = meeting.get('start', {}).get('dateTime') or meeting.get('start', {}).get('date') or meeting.get('start')
    if meeting_start:
        meeting_date = datetime.fromisoformat(meeting_start.replace('Z', '+00:00'))
        # Ensure timezone-aware (if naive, assume UTC)
        if meeting_date.tzinfo is None:
            meeting_date = meeting_date.replace(tzinfo=timezone.utc)
    else:
        meeting_date = datetime.now(timezone.utc)
    
    # Use end of meeting day as cutoff (23:59:59) to include emails from the same day
    meeting_cutoff = meeting_date.replace(hour=23, minute=59, second=59, microsecond=999999)
    before_date = meeting_cutoff.strftime('%Y/%m/%d')
    
    # CRITICAL: 2-YEAR lookback FROM MEETING DATE (not from today)
    two_years_ago = meeting_date - timedelta(days=730)
    after_date = two_years_ago.strftime('%Y/%m/%d')

    async def fetch_account_emails(account: Dict[str, Any]) -> Dict[str, Any]:
        try:
            account_email = account.get('account_email', 'unknown')

            # Build enhanced Gmail search query with keywords and date filter
            attendee_emails = [
                a.get('email') or a.get('emailAddress')
                for a in attendees
                if a.get('email') or a.get('emailAddress')
            ]

            # Handle empty attendees case
            if len(attendee_emails) == 0:
                logger.warning('   ⚠️  No attendee emails provided, using keyword-only search')
                if len(keywords) == 0:
                    return {
                        'accountEmail': account_email,
                        'emails': [],
                        'success': True
                    }
                keyword_parts = ' OR '.join([f'subject:"{k}" OR "{k}"' for k in keywords[:3]])
                query = f'({keyword_parts}) after:{after_date} before:{before_date}'
                emails = await fetch_gmail_messages(account, query, 100)
                
                # Post-fetch filtering: Remove any emails after meeting date
                filtered_emails = []
                for e in emails:
                    if not e.get('date'):
                        filtered_emails.append(e)
                        continue
                    email_date = parse_email_date(e['date'])
                    if email_date and email_date <= meeting_date:
                        filtered_emails.append(e)
                emails = filtered_emails
                
                return {
                    'accountEmail': account_email,
                    'emails': emails,
                    'success': True
                }

            domains = list(set([e.split('@')[1] for e in attendee_emails if '@' in e]))

            attendee_queries = ' OR '.join([f'from:{email} OR to:{email}' for email in attendee_emails])
            domain_queries = ' OR '.join([f'from:*@{d}' for d in domains]) if domains else ''

            # Add keyword search
            keyword_query = ''
            if keywords:
                keyword_parts = ' OR '.join([f'subject:"{k}" OR "{k}"' for k in keywords[:3]])
                keyword_query = f'({keyword_parts})'

            # Build query parts conditionally
            query_parts = []
            if attendee_queries:
                query_parts.append(f'({attendee_queries})')
            if domain_queries:
                query_parts.append(f'({domain_queries})')
            if keyword_query:
                query_parts.append(keyword_query)

            if len(query_parts) == 0:
                logger.warning('   ⚠️  No valid query parts to search')
                return {
                    'accountEmail': account_email,
                    'emails': [],
                    'success': True
                }

            query = f'{" OR ".join(query_parts)} after:{after_date} before:{before_date}'

            # Fetch up to 100 emails
            emails = await fetch_gmail_messages(account, query, 100)
            
            # Post-fetch filtering: Remove any emails after meeting date
            emails = [
                e for e in emails
                if not e.get('date') or datetime.fromisoformat(e['date'].replace('Z', '+00:00')) <= meeting_date
            ]

            logger.debug(f'   ✅ Fetched {len(emails)} emails from {account_email}')

            return {
                'accountEmail': account_email,
                'emails': emails,
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

    # Fetch from all accounts in parallel
    results = await asyncio.gather(*[fetch_account_emails(acc) for acc in accounts], return_exceptions=True)

    # Process results
    all_emails = []
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
                all_emails.extend(result.get('emails', []))
                account_stats['successfulAccounts'] += 1
            else:
                account_stats['failedAccounts'].append({
                    'accountEmail': result.get('accountEmail'),
                    'error': result.get('error')
                })
                account_stats['partialFailure'] = True

    # Deduplicate emails
    deduplicated_emails = merge_and_deduplicate_emails([r.get('emails', []) for r in results if isinstance(r, dict) and r.get('success')])

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
    meeting_start = meeting.get('start', {}).get('dateTime') or meeting.get('start', {}).get('date') or meeting.get('start')
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
        a.get('email') or a.get('emailAddress')
        for a in attendees
        if a.get('email') or a.get('emailAddress')
    ]

    async def fetch_account_files(account: Dict[str, Any]) -> Dict[str, Any]:
        try:
            account_email = account.get('account_email', 'unknown')
            
            if len(attendee_emails) == 0:
                return {
                    'accountEmail': account_email,
                    'files': [],
                    'success': True
                }

            # Build permission query
            perm_queries = ' or '.join([
                f"'{email}' in readers or '{email}' in writers"
                for email in attendee_emails
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
    meeting_date: datetime
) -> Dict[str, Any]:
    """
    Fetch calendar events from all connected accounts (6-MONTH LOOKBACK)
    Args:
        accounts: Array of account objects
        meeting_date: Meeting date for context
    Returns:
        Dict with calendar events
    """
    logger.info(f'📅 Fetching calendar events from {len(accounts)} account(s)...')

    # Ensure meeting_date is timezone-aware (for RFC3339 format)
    if meeting_date.tzinfo is None:
        meeting_date = meeting_date.replace(tzinfo=timezone.utc)
    
    # 6-MONTH lookback FROM MEETING DATE
    six_months_ago = meeting_date - timedelta(days=180)
    # Ensure timezone-aware for RFC3339 format
    if six_months_ago.tzinfo is None:
        six_months_ago = six_months_ago.replace(tzinfo=timezone.utc)
    
    time_min = six_months_ago.isoformat()
    time_max = meeting_date.isoformat()

    async def fetch_account_calendar(account: Dict[str, Any]) -> List[Dict[str, Any]]:
        try:
            events = await fetch_calendar_events(account, time_min, time_max, 100)
            return events
        except Exception as error:
            logger.error(f'   ❌ Error fetching calendar for {account.get("account_email", "unknown")}: {str(error)}')
            return []

    # Fetch from all accounts in parallel
    results = await asyncio.gather(*[fetch_account_calendar(acc) for acc in accounts], return_exceptions=True)

    # Process results
    all_events = []
    for result in results:
        if isinstance(result, list):
            all_events.extend(result)
        elif isinstance(result, Exception):
            logger.error(f'   ❌ Calendar fetch exception: {str(result)}')

    # Deduplicate events
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
