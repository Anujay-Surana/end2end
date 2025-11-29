"""
Google API Service

Centralized functions for interacting with Google APIs:
- Gmail API (fetch emails)
- Drive API (fetch files and content)
- Calendar API (fetch events)
"""

import base64
import asyncio
from urllib.parse import quote_plus
from typing import Dict, List, Any, Optional, Union
from app.services.google_api_retry import fetch_with_retry
from app.services.token_refresh import ensure_valid_token
from app.services.logger import logger


async def fetch_gmail_messages(
    access_token_or_account: Union[str, Dict[str, Any]],
    query: str,
    max_results: int = 100
) -> List[Dict[str, Any]]:
    """
    Fetch Gmail messages using query with automatic token refresh on 401
    Args:
        access_token_or_account: Google OAuth access token (string) or account object with token refresh capability
        query: Gmail search query
        max_results: Maximum number of messages to fetch
    Returns:
        Array of parsed email messages
    """
    # Support both token string (backward compatibility) and account object (new)
    is_account_object = isinstance(access_token_or_account, dict) and access_token_or_account is not None
    access_token = access_token_or_account.get('access_token') if is_account_object else access_token_or_account
    account = access_token_or_account if is_account_object else None
    
    try:
        logger.info(f"  📧 Gmail query: {query[:150]}...")

        # Step 1: Get message IDs (with retry logic)
        list_url = f"https://www.googleapis.com/gmail/v1/users/me/messages?q={quote_plus(query)}&maxResults={max_results}"
        list_response = await fetch_with_retry(
            list_url,
            {'headers': {'Authorization': f'Bearer {access_token}'}}
        )

        if not list_response.is_success:
            # If 401 and we have account object, try refreshing token once
            if list_response.status_code == 401 and account:
                logger.info(f"  🔄 401 error detected, attempting token refresh for {account.get('account_email')}...")
                try:
                    refreshed_account = await ensure_valid_token(account)
                    access_token = refreshed_account.get('access_token')
                    account = refreshed_account  # Update account reference
                    
                    # Retry the request with refreshed token
                    retry_response = await fetch_with_retry(
                        list_url,
                        {'headers': {'Authorization': f'Bearer {access_token}'}}
                    )
                    
                    if not retry_response.is_success:
                        raise Exception(f'Gmail API error after token refresh: {retry_response.status_code}')
                    
                    # Use retry response
                    retry_data = retry_response.json()
                    message_ids = retry_data.get('messages', [])
                    logger.info(f"  ✓ Found {len(message_ids)} message IDs (after token refresh)")
                    
                    if len(message_ids) == 0:
                        return []
                    
                    # Continue with message fetching using refreshed token
                    return await _fetch_gmail_messages_with_token(access_token, message_ids, max_results, account)
                except Exception as refresh_error:
                    # Check if refresh token is revoked
                    error_msg = str(refresh_error)
                    if 'REVOKED_TOKEN' in error_msg or 'invalid_grant' in error_msg:
                        logger.error(f"  ❌ Token refresh failed - refresh token revoked for {account.get('account_email')}")
                        raise Exception(f'REVOKED_TOKEN: Account {account.get("account_email")} needs to re-authenticate. Refresh token has been revoked.')
                    account_email = account.get('account_email')
                    logger.error(f"  ❌ Token refresh failed for {account_email}: {error_msg}")
                    raise Exception(f'Gmail API error: {list_response.status_code} (token refresh failed: {error_msg})')
            raise Exception(f'Gmail API error: {list_response.status_code}')

        list_data = list_response.json()
        message_ids = list_data.get('messages', [])

        logger.info(f"  ✓ Found {len(message_ids)} message IDs")

        if len(message_ids) == 0:
            return []

        # Step 2: Fetch full message details
        return await _fetch_gmail_messages_with_token(access_token, message_ids, max_results, account)
    except Exception as error:
        logger.error(f"  ❌ Error fetching Gmail messages: {str(error)}")
        raise


async def _fetch_gmail_messages_with_token(
    access_token: str,
    message_ids: List[Dict[str, str]],
    max_results: int,
    account: Optional[Dict[str, Any]] = None
) -> List[Dict[str, Any]]:
    """
    Helper function to fetch message details with token (supports refresh retry)
    """
    try:
        # Process in batches of 20 to avoid rate limits
        logger.info(f"  📧 Fetching full details for ALL {len(message_ids)} messages (batches of 20)...")
        all_messages = []

        for i in range(0, len(message_ids), 20):
            batch = message_ids[i:i + 20]
            logger.info(f"     Processing email batch {i // 20 + 1}/{(len(message_ids) + 19) // 20} ({len(batch)} emails)...")

            async def fetch_message(msg: Dict[str, str]) -> Optional[Dict[str, Any]]:
                try:
                    msg_url = f"https://www.googleapis.com/gmail/v1/users/me/messages/{msg['id']}?format=full"
                    msg_response = await fetch_with_retry(
                        msg_url,
                        {'headers': {'Authorization': f'Bearer {access_token}'}}
                    )
                    
                    # Handle 401 with token refresh
                    if not msg_response.is_success and msg_response.status_code == 401 and account:
                        logger.info("  🔄 401 on message fetch, refreshing token...")
                        refreshed_account = await ensure_valid_token(account)
                        access_token = refreshed_account.get('access_token')
                        account = refreshed_account
                        
                        # Retry with refreshed token
                        msg_response = await fetch_with_retry(
                            msg_url,
                            {'headers': {'Authorization': f'Bearer {access_token}'}}
                        )
                    
                    if not msg_response.is_success:
                        return None

                    return msg_response.json()
                except Exception as error:
                    logger.error(f"  ⚠️  Error fetching message {msg.get('id')}: {str(error)}")
                    return None

            batch_tasks = [fetch_message(msg) for msg in batch]
            batch_messages = await asyncio.gather(*batch_tasks)
            batch_messages = [msg for msg in batch_messages if msg is not None]
            all_messages.extend(batch_messages)

        messages = all_messages
        logger.info(f"  ✓ Fetched {len(messages)}/{len(message_ids)} full messages")

        # Step 3: Parse and format messages
        parsed_messages = []
        for msg in messages:
            headers = msg.get('payload', {}).get('headers', [])
            
            def get_header(name: str) -> str:
                for h in headers:
                    if h.get('name', '').lower() == name.lower():
                        return h.get('value', '')
                return ''

            body = ''
            attachments = []
            
            # Extract body and attachments from email parts
            payload = msg.get('payload', {})
            parts = payload.get('parts', [])
            
            if parts:
                for part in parts:
                    # Check for text content
                    if part.get('mimeType') == 'text/plain' and part.get('body', {}).get('data'):
                        body = base64.b64decode(part['body']['data']).decode('utf-8')
                    # Check for attachments
                    if part.get('filename') and part.get('body', {}).get('attachmentId'):
                        attachments.append({
                            'filename': part.get('filename'),
                            'mimeType': part.get('mimeType'),
                            'size': part.get('body', {}).get('size'),
                            'attachmentId': part.get('body', {}).get('attachmentId')
                        })
                    # Check nested parts (multipart messages)
                    if part.get('parts'):
                        for sub_part in part['parts']:
                            if sub_part.get('filename') and sub_part.get('body', {}).get('attachmentId'):
                                attachments.append({
                                    'filename': sub_part.get('filename'),
                                    'mimeType': sub_part.get('mimeType'),
                                    'size': sub_part.get('body', {}).get('size'),
                                    'attachmentId': sub_part.get('body', {}).get('attachmentId')
                                })
            elif payload.get('body', {}).get('data'):
                body = base64.b64decode(payload['body']['data']).decode('utf-8')

            # Preserve full email body (up to 50k chars for very long emails)
            # Truncation will be applied later when needed for GPT calls
            full_body = body[:50000] + '\n\n[Email truncated - showing first 50k chars]' if len(body) > 50000 else body
            
            parsed_messages.append({
                'id': msg.get('id'),
                'subject': get_header('Subject'),
                'from': get_header('From'),
                'to': get_header('To'),
                'date': get_header('Date'),
                'snippet': msg.get('snippet', ''),
                'body': full_body,  # Full body preserved for filtering decisions
                'attachments': attachments if attachments else None  # Include attachment metadata
            })
        
        return parsed_messages
    except Exception as error:
        logger.error(f'  ❌ Error fetching Gmail messages: {str(error)}')
        return []


async def fetch_drive_files(
    access_token_or_account: Union[str, Dict[str, Any]],
    query: str,
    max_results: int = 50
) -> List[Dict[str, Any]]:
    """
    Fetch Google Drive files using query with automatic token refresh on 401
    Args:
        access_token_or_account: Google OAuth access token (string) or account object
        query: Drive search query
        max_results: Maximum number of files to fetch
    Returns:
        Array of file metadata
    """
    is_account_object = isinstance(access_token_or_account, dict) and access_token_or_account is not None
    access_token = access_token_or_account.get('access_token') if is_account_object else access_token_or_account
    account = access_token_or_account if is_account_object else None
    
    try:
        logger.info(f"  📁 Drive query: {query[:150]}...")

        drive_url = (
            f"https://www.googleapis.com/drive/v3/files?"
            f"q={quote_plus(query)}&"
            f"fields=files(id,name,mimeType,modifiedTime,owners,size,webViewLink,iconLink)&"
            f"orderBy=modifiedTime desc&"
            f"pageSize={max_results}"
        )
        
        response = await fetch_with_retry(
            drive_url,
            {'headers': {'Authorization': f'Bearer {access_token}'}}
        )

        if not response.is_success:
            # If 401 and we have account object, try refreshing token once
            if response.status_code == 401 and account:
                logger.info(f"  🔄 401 error detected, attempting token refresh for {account.get('account_email')}...")
                try:
                    refreshed_account = await ensure_valid_token(account)
                    access_token = refreshed_account.get('access_token')
                    account = refreshed_account
                    
                    # Retry the request with refreshed token
                    retry_response = await fetch_with_retry(
                        drive_url,
                        {'headers': {'Authorization': f'Bearer {access_token}'}}
                    )
                    
                    if not retry_response.is_success:
                        raise Exception(f'Drive API error after token refresh: {retry_response.status_code}')
                    
                    retry_data = retry_response.json()
                    return retry_data.get('files', [])
                except Exception as refresh_error:
                    # Check if refresh token is revoked
                    error_msg = str(refresh_error)
                    if 'REVOKED_TOKEN' in error_msg or 'invalid_grant' in error_msg:
                        logger.error(f"  ❌ Token refresh failed - refresh token revoked for {account.get('account_email')}")
                        raise Exception(f'REVOKED_TOKEN: Account {account.get("account_email")} needs to re-authenticate. Refresh token has been revoked.')
                    logger.error(f"  ❌ Token refresh failed for {account.get('account_email')}: {error_msg}")
                    raise Exception(f'Drive API error: {response.status_code} (token refresh failed: {error_msg})')
            raise Exception(f'Drive API error: {response.status_code}')

        data = response.json()
        files = data.get('files', [])

        logger.info(f"  ✓ Found {len(files)} Drive files")

        return [{
            'id': file.get('id'),
            'name': file.get('name'),
            'mimeType': file.get('mimeType'),
            'size': file.get('size', 0),
            'modifiedTime': file.get('modifiedTime'),
            'owner': file.get('owners', [{}])[0].get('displayName', 'Unknown') if file.get('owners') else 'Unknown',
            'ownerEmail': file.get('owners', [{}])[0].get('emailAddress', '') if file.get('owners') else '',
            'url': file.get('webViewLink'),
            'iconLink': file.get('iconLink')
        } for file in files]

    except Exception as error:
        logger.error(f'  ❌ Error fetching Drive files: {str(error)}')
        return []


async def fetch_drive_file_contents(
    access_token_or_account: Union[str, Dict[str, Any]],
    files: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Fetch Drive file contents with automatic token refresh on 401
    Args:
        access_token_or_account: Google OAuth access token (string) or account object
        files: Array of file metadata objects
    Returns:
        Array of files with content included
    """
    is_account_object = isinstance(access_token_or_account, dict) and access_token_or_account is not None
    access_token = access_token_or_account.get('access_token') if is_account_object else access_token_or_account
    account = access_token_or_account if is_account_object else None
    
    files_with_content = []

    # Process ALL files found (no artificial limit)
    # Process in batches of 10 to avoid timeouts
    logger.info(f"  📄 Fetching content for ALL {len(files)} files (processing in batches of 10)...")

    for i in range(0, len(files), 10):
        batch = files[i:i + 10]
        logger.info(f"     Processing batch {i // 10 + 1}/{(len(files) + 9) // 10} ({len(batch)} files)...")

        async def fetch_file_content(file: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            try:
                content = ''

                # Handle different file types
                mime_type = file.get('mimeType', '')
                file_id = file.get('id')
                
                if mime_type == 'application/vnd.google-apps.document':
                    # Google Doc - export as plain text
                    export_url = f"https://www.googleapis.com/drive/v3/files/{file_id}/export?mimeType=text/plain"
                    response = await fetch_with_retry(
                        export_url,
                        {'headers': {'Authorization': f'Bearer {access_token}'}}
                    )
                    
                    # Handle 401 with token refresh
                    if not response.is_success and response.status_code == 401 and account:
                        refreshed_account = await ensure_valid_token(account)
                        access_token = refreshed_account.get('access_token')
                        account = refreshed_account
                        response = await fetch_with_retry(
                            export_url,
                            {'headers': {'Authorization': f'Bearer {access_token}'}}
                        )
                    
                    if response.is_success:
                        content = response.text
                elif mime_type in ['application/pdf', 'text/plain']:
                    # PDF or text file - get binary content
                    media_url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
                    response = await fetch_with_retry(
                        media_url,
                        {'headers': {'Authorization': f'Bearer {access_token}'}}
                    )
                    
                    # Handle 401 with token refresh
                    if not response.is_success and response.status_code == 401 and account:
                        refreshed_account = await ensure_valid_token(account)
                        access_token = refreshed_account.get('access_token')
                        account = refreshed_account
                        response = await fetch_with_retry(
                            media_url,
                            {'headers': {'Authorization': f'Bearer {access_token}'}}
                        )
                    
                    if response.is_success:
                        content = response.text

                if content:
                    return {
                        **file,
                        'content': content[:50000],  # Limit to 50k chars per file
                        'hasContent': True  # Flag to indicate content was successfully fetched
                    }
                return {
                    **file,
                    'hasContent': False  # Flag to indicate content fetch failed
                }
            except Exception as error:
                logger.error(f"  ⚠️  Error fetching content for {file.get('name')}: {str(error)}")
                return None

        batch_tasks = [fetch_file_content(file) for file in batch]
        batch_results = await asyncio.gather(*batch_tasks, return_exceptions=True)

        # Collect successful results
        for result in batch_results:
            if result and isinstance(result, dict):
                files_with_content.append(result)

    logger.info(f"  ✓ Successfully fetched content for {len(files_with_content)}/{len(files)} files")
    return files_with_content


async def fetch_user_profile(access_token: str, retry_count: int = 0) -> Dict[str, Any]:
    """
    Fetch user profile information
    Args:
        access_token: Google OAuth access token
        retry_count: Current retry attempt
    Returns:
        User profile { email, name, picture }
    """
    max_retries = 3
    try:
        if not access_token:
            raise Exception('Access token is missing or undefined')
        
        logger.info(f'Fetching user profile with token (preview): {access_token[:20]}...')
        
        response = await fetch_with_retry(
            'https://www.googleapis.com/oauth2/v2/userinfo',
            {
                'headers': {
                    'Authorization': f'Bearer {access_token}',
                    'Content-Type': 'application/json'
                }
            }
        )

        if not response.is_success:
            # Add better error details for debugging
            error_text = response.text
            logger.error('User info API error details:', {
                'status': response.status_code,
                'statusText': response.reason_phrase,
                'body': error_text,
                'tokenPreview': access_token[:20] + '...' if access_token else 'MISSING',
                'hasToken': bool(access_token)
            })
            raise Exception(f'User info API error: {response.status_code} - {error_text or response.reason_phrase}')

        data = response.json()
        return {
            'email': data.get('email'),
            'name': data.get('name'),
            'picture': data.get('picture'),
            'verifiedEmail': data.get('verified_email')
        }
    except Exception as error:
        logger.error(f'Error fetching user profile: {str(error)}')
        raise


async def fetch_calendar_events(
    access_token_or_account: Union[str, Dict[str, Any]],
    time_min: str,
    time_max: str,
    max_results: int = 100
) -> List[Dict[str, Any]]:
    """
    Fetch Google Calendar events using Calendar API v3 with automatic token refresh on 401
    Args:
        access_token_or_account: Google OAuth access token (string) or account object
        time_min: Start time (ISO string)
        time_max: End time (ISO string)
        max_results: Maximum number of events to fetch
    Returns:
        Array of calendar events
    """
    is_account_object = isinstance(access_token_or_account, dict) and access_token_or_account is not None
    access_token = access_token_or_account.get('access_token') if is_account_object else access_token_or_account
    account = access_token_or_account if is_account_object else None
    
    try:
        logger.info(f"  📅 Calendar query: {time_min} to {time_max}")

        calendar_url = (
            f"https://www.googleapis.com/calendar/v3/calendars/primary/events?"
            f"timeMin={time_min}&"
            f"timeMax={time_max}&"
            f"singleEvents=true&"
            f"orderBy=startTime&"
            f"maxResults={max_results}"
        )
        
        response = await fetch_with_retry(
            calendar_url,
            {'headers': {'Authorization': f'Bearer {access_token}'}}
        )

        if not response.is_success:
            # If 401 and we have account object, try refreshing token once
            if response.status_code == 401 and account:
                logger.info(f"  🔄 401 error detected, attempting token refresh for {account.get('account_email')}...")
                try:
                    refreshed_account = await ensure_valid_token(account)
                    access_token = refreshed_account.get('access_token')
                    account = refreshed_account
                    
                    # Retry the request with refreshed token
                    retry_response = await fetch_with_retry(
                        calendar_url,
                        {'headers': {'Authorization': f'Bearer {access_token}'}}
                    )
                    
                    if not retry_response.is_success:
                        raise Exception(f'Calendar API error after token refresh: {retry_response.status_code}')
                    
                    retry_data = retry_response.json()
                    retry_events = retry_data.get('items', [])
                    logger.info(f"  ✓ Found {len(retry_events)} calendar events after token refresh")
                    return [_format_calendar_event(event) for event in retry_events]
                except Exception as refresh_error:
                    # Check if refresh token is revoked
                    error_msg = str(refresh_error)
                    if 'REVOKED_TOKEN' in error_msg or 'invalid_grant' in error_msg:
                        logger.error(f"  ❌ Token refresh failed - refresh token revoked for {account.get('account_email')}")
                        raise Exception(f'REVOKED_TOKEN: Account {account.get("account_email")} needs to re-authenticate. Refresh token has been revoked.')
                    logger.error(f"  ❌ Token refresh failed for {account.get('account_email')}: {error_msg}")
                    raise Exception(f'Calendar API error: {response.status_code} (token refresh failed: {error_msg})')
            raise Exception(f'Calendar API error: {response.status_code}')

        data = response.json()
        events = data.get('items', [])

        logger.info(f"  ✓ Found {len(events)} calendar events")

        return [_format_calendar_event(event) for event in events]

    except Exception as error:
        logger.error(f'  ❌ Error fetching Calendar events: {str(error)}')
        return []


def _format_calendar_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """Format a calendar event to standard format"""
    return {
        'id': event.get('id'),
        'summary': event.get('summary') or 'No title',
        'description': event.get('description') or '',
        'start': event.get('start', {}).get('dateTime') or event.get('start', {}).get('date') or '',
        'end': event.get('end', {}).get('dateTime') or event.get('end', {}).get('date') or '',
        'attendees': [{
            'email': a.get('email'),
            'displayName': a.get('displayName'),
            'responseStatus': a.get('responseStatus')
        } for a in (event.get('attendees') or [])],
        'location': event.get('location') or '',
        'htmlLink': event.get('htmlLink'),
        'creator': event.get('creator', {}).get('email') or '',
        'organizer': event.get('organizer', {}).get('email') or ''
    }

