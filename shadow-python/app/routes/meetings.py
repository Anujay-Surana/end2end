"""
Meetings Routes

Meeting preparation endpoints with AI analysis
Supports multi-account and single-account modes
"""

import asyncio
import json
import re
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any, Optional, AsyncGenerator
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.middleware.auth import optional_auth
from app.db.queries.accounts import get_accounts_by_user_id
from app.services.logger import logger
from app.services.gpt_service import call_gpt, safe_parse_json, synthesize_results
from app.services.user_context import get_user_context, filter_user_from_attendees
from app.services.google_api import parse_email_date
from app.services.user_profiling import build_user_profile
from app.services.token_refresh import ensure_all_tokens_valid
from app.services.multi_account_fetcher import (
    fetch_all_account_context,
    fetch_calendar_from_all_accounts,
    merge_and_deduplicate_calendar_events
)
from app.services.attendee_research import research_attendees
from app.services.email_relevance import filter_relevant_emails
from app.services.calendar_event_classifier import classify_calendar_event, should_prep_event, get_prep_depth
from app.services.meeting_purpose_detector import detect_meeting_purpose
from app.services.document_analyzer import analyze_documents
from app.services.executive_summary import generate_executive_summary
from app.services.temporal_scoring import analyze_trend

router = APIRouter()


class MeetingPrepRequest(BaseModel):
    meeting: Dict[str, Any]
    attendees: List[Dict[str, Any]]
    accessToken: Optional[str] = None


def format_meeting_date(meeting: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Format meeting date for temporal context"""
    start = meeting.get('start', {}).get('dateTime') or meeting.get('start', {}).get('date') or meeting.get('start')
    if not start:
        return None

    try:
        date = datetime.fromisoformat(start.replace('Z', '+00:00'))
        now = datetime.utcnow()
        diff_days = (date.replace(tzinfo=None) - now.replace(tzinfo=None)).days

        if diff_days < 0:
            relative = f'{abs(diff_days)} day{"s" if abs(diff_days) != 1 else ""} ago'
        elif diff_days == 0:
            relative = 'today'
        elif diff_days == 1:
            relative = 'tomorrow'
        else:
            relative = f'in {diff_days} days'

        return {
            'iso': date.isoformat(),
            'readable': date.strftime('%A, %B %d, %Y'),
            'time': date.strftime('%I:%M %p'),
            'relative': relative,
            'date': date
        }
    except Exception:
        return None


async def understand_meeting_context(
    meeting: Dict[str, Any],
    attendees: List[Dict[str, Any]],
    user_context: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    """Understand meeting context dynamically from available information"""
    meeting_title = meeting.get('summary') or meeting.get('title') or 'Untitled Meeting'
    meeting_description = meeting.get('description', '')

    attendee_info = [
        {
            'name': a.get('displayName') or a.get('name') or (a.get('email') or a.get('emailAddress') or '').split('@')[0] or 'Unknown',
            'email': a.get('email') or a.get('emailAddress')
        }
        for a in (attendees or [])
    ]

    user_context_prefix = ''
    if user_context:
        user_context_prefix = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). '

    try:
        analysis = await call_gpt([{
            'role': 'system',
            'content': (
                f'{user_context_prefix}You are analyzing a meeting to understand its context and purpose. Your goal is to extract key information that will help filter relevant emails.\n\n'
                f'CRITICAL: Don\'t make assumptions. Only extract information that is clearly present in the available context.\n\n'
                f'Analyze:\n'
                f'- Meeting title: What does it tell us?\n'
                f'- Meeting description: What additional context is provided?\n'
                f'- Attendees: Who are the key people involved?\n'
                f'- Extract entities: Person names, project names, topics mentioned\n\n'
                f'Return JSON:\n'
                f'{{\n'
                f'  "understoodPurpose": "What this meeting is actually about based on available context (be specific, don\'t guess)",\n'
                f'  "keyEntities": ["extracted entities like person names, projects, topics"],\n'
                f'  "keyTopics": ["extracted topics/themes"],\n'
                f'  "isSpecificMeeting": true/false,\n'
                f'  "confidence": "high" | "medium" | "low",\n'
                f'  "reasoning": "Why we think this based on available context"\n'
                f'}}\n\n'
                f'Guidelines:\n'
                f'- If context is insufficient, mark confidence as "low" and be conservative\n'
                f'- Don\'t assume meeting types\n'
                f'- Extract entities from actual context, not patterns\n'
                f'- If you can\'t determine purpose clearly, say so'
            )
        }, {
            'role': 'user',
            'content': (
                f'Meeting Title: "{meeting_title}"\n'
                + (f'Meeting Description: "{meeting_description}"\n' if meeting_description else 'No description provided\n')
                + f'Attendees: {", ".join([a["name"] + (" (" + a["email"] + ")" if a.get("email") else "") for a in attendee_info]) or "No attendees listed"}\n'
                + (f'User: {user_context["formattedName"]} ({user_context["formattedEmail"]})\n\n' if user_context else '\n')
                + 'Analyze this meeting and extract its context.'
            )
        }], 4000)

        context = safe_parse_json(analysis) or {}

        return {
            'understoodPurpose': context.get('understoodPurpose') or 'Meeting purpose unclear from available context',
            'keyEntities': context.get('keyEntities') if isinstance(context.get('keyEntities'), list) else [],
            'keyTopics': context.get('keyTopics') if isinstance(context.get('keyTopics'), list) else [],
            'isSpecificMeeting': context.get('isSpecificMeeting') is True,
            'confidence': context.get('confidence') or 'low',
            'reasoning': context.get('reasoning') or 'Context analysis completed'
        }
    except Exception as e:
        logger.error(f'Failed to understand meeting context: {str(e)}')
        return {
            'understoodPurpose': 'Meeting purpose unclear from available context',
            'keyEntities': [],
            'keyTopics': [],
            'isSpecificMeeting': False,
            'confidence': 'low',
            'reasoning': 'Failed to analyze meeting context'
        }


async def _generate_prep_response(
    request_body: MeetingPrepRequest,
    user: Optional[Dict[str, Any]],
    request: Request,
    request_id: str
) -> AsyncGenerator[str, None]:
    """
    Generator function that yields progress chunks and final result
    Sends keep-alive chunks every 10 seconds to prevent Railway timeout
    """
    start_time = datetime.now()
    last_keepalive = start_time
    KEEPALIVE_INTERVAL = timedelta(seconds=10)  # Send keep-alive every 10 seconds
    
    def send_progress(step: str, data: Optional[Dict] = None):
        """Helper to yield progress chunk"""
        progress = {
            'type': 'progress',
            'step': step,
            'timestamp': datetime.now().isoformat(),
            'elapsedSeconds': round((datetime.now() - start_time).total_seconds(), 1)
        }
        if data:
            progress['data'] = data
        return json.dumps(progress) + '\n'
    
    try:
        # Yield initial progress
        yield send_progress('starting', {'message': 'Initializing meeting prep...'})
        
        meeting = request_body.meeting
        attendees = request_body.attendees or []
        access_token = request_body.accessToken

        # Handle Google Calendar format
        meeting_title = meeting.get('summary') or meeting.get('title') or 'Untitled Meeting'
        if not meeting.get('summary') and meeting.get('title'):
            meeting['summary'] = meeting['title']

        meeting_date = format_meeting_date(meeting)
        meeting_date_context = ''
        if meeting_date:
            today_str = datetime.utcnow().strftime('%B %d, %Y')
            meeting_date_context = f'\n\nIMPORTANT TEMPORAL CONTEXT: This meeting is scheduled for {meeting_date["readable"]} at {meeting_date["time"]} ({meeting_date["relative"]}). Today is {today_str}. Focus on information relevant to THIS specific meeting on {meeting_date["readable"]}, not past meetings with similar names or topics.'

        # Get user context
        user_context = await get_user_context(user, request_id) if user else None
        
        # Check keep-alive
        if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
            yield send_progress('keepalive', {'message': 'Processing...'})
            last_keepalive = datetime.now()
        
        # Classify the meeting event
        user_email = user_context.get('email') if user_context else (user.get('email') if user else '')
        user_emails = user_context.get('emails', []) if user_context else []
        classification = classify_calendar_event(meeting, user_email, user_emails)
        
        # Skip full prep for non-meeting events
        if not should_prep_event(classification):
            prep_depth = get_prep_depth(classification)
            logger.info(
                f'Event classified as {classification["type"]}, skipping full prep',
                requestId=request_id,
                prepDepth=prep_depth,
                reason=classification.get('reason')
            )
            
            # Return minimal brief for non-meeting events
            result = {
                'type': 'complete',
                'success': True,
                'summary': f'{meeting_title} - {classification.get("reason", "Non-meeting event")}',
                'attendees': attendees,
                'meeting': meeting,
                'classification': classification,
                'prepDepth': prep_depth,
                'note': 'This event was classified as a non-meeting. Full prep skipped.'
            }
            yield json.dumps(result) + '\n'
            return

        logger.info(
            f'Starting meeting prep request',
            requestId=request_id,
            meetingTitle=meeting_title,
            meetingDate=meeting_date.get('readable') if meeting_date else 'unknown',
            attendeeCount=len(attendees),
            hasAccessToken=bool(access_token),
            userId=user.get('id') if user else 'anonymous',
            userName=user_context.get('name') if user_context else 'unknown',
            eventType=classification.get('type'),
            prepDepth=classification.get('prepDepth')
        )

        user_info = f' (User: {user_context["name"]})' if user_context else ''
        logger.info(f'\n📋 Preparing brief for: {meeting_title}{user_info}', requestId=request_id)

        # Filter user from attendees
        other_attendees = filter_user_from_attendees(attendees, user_context) if user_context else attendees
        logger.info(f'👥 Attendees: {len(attendees)} total, {len(other_attendees)} others (excluding user)', requestId=request_id)

        brief = {
            'summary': '',
            'attendees': [],
            '_extractionData': {
                'userContext': None,
                'attendeeExtractions': [],
                'relevantContent': {
                    'emails': [],
                    'documents': []
                }
            },
            'companies': [],
            'actionItems': [],
            'context': '',
            '_multiAccountStats': None
        }

        emails = []
        files = []
        calendar_events = []
        accounts = []

        # ===== MULTI-ACCOUNT MODE (NEW) =====
        if user and user.get('id'):
            yield send_progress('fetching_context', {'message': 'Fetching emails, files, and calendar events...'})
            
            # Check keep-alive
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': 'Fetching data from accounts...'})
                last_keepalive = datetime.now()

            logger.info(f'\n🚀 Multi-account mode: Fetching from all connected accounts', requestId=request_id)

            accounts = await get_accounts_by_user_id(user['id'])
            if not accounts:
                error_result = {'type': 'error', 'error': 'No accounts connected. Please connect at least one Google account.'}
                yield json.dumps(error_result) + '\n'
                return

            # Validate all tokens
            token_validation_result = await ensure_all_tokens_valid(accounts)
            
            # Check keep-alive after token validation
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': 'Validating accounts...'})
                last_keepalive = datetime.now()
            
            if not token_validation_result.get('validAccounts'):
                failed_accounts = token_validation_result.get('failedAccounts', [])
                all_revoked = all(f.get('isRevoked') for f in failed_accounts)
                error_result = {
                    'type': 'error',
                    'statusCode': 401,
                    'error': 'TokenRevoked' if all_revoked else 'AuthenticationError',
                    'message': 'Your session has expired. Please sign in again.' if all_revoked else 'All accounts need to re-authenticate',
                    'revoked': all_revoked,
                    'failedAccounts': [
                        {
                            'email': a.get('account_email'),
                            'reason': 'Token revoked' if a.get('isRevoked') else 'Token expired',
                            'isRevoked': a.get('isRevoked')
                        }
                        for a in failed_accounts
                    ]
                }
                yield json.dumps(error_result) + '\n'
                return

            accounts = token_validation_result['validAccounts']

            # Fetch context from ALL accounts in parallel
            yield send_progress('fetching_data', {'message': 'Fetching emails, files, and calendar events...'})
            
            context_result = await fetch_all_account_context(accounts, attendees, meeting)
            emails = context_result.get('emails', [])
            files = context_result.get('files', [])
            brief['_multiAccountStats'] = context_result.get('accountStats', {})
            
            # Check keep-alive after fetching context
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': f'Fetched {len(emails)} emails, {len(files)} files...'})
                last_keepalive = datetime.now()

            # Fetch calendar events
            # Extract meeting date from meeting object (as datetime for calendar query)
            meeting_start = meeting.get('start', {}).get('dateTime') or meeting.get('start', {}).get('date') or meeting.get('start')
            if meeting_start:
                meeting_datetime = datetime.fromisoformat(meeting_start.replace('Z', '+00:00'))
                # Ensure timezone-aware (if naive, assume UTC)
                if meeting_datetime.tzinfo is None:
                    meeting_datetime = meeting_datetime.replace(tzinfo=timezone.utc)
            else:
                meeting_datetime = datetime.now(timezone.utc)
            
            calendar_result = await fetch_calendar_from_all_accounts(accounts, meeting_datetime)
            calendar_events = calendar_result.get('results', [])

            # ===== BUILD USER CONTEXT/PROFILE =====
            # Always set basic user context, even if there are no emails
            if user_context:
                logger.info(f'\n  👤 Building user context/profile...', requestId=request_id)
                try:
                    # Always set basic user info first
                    brief['_extractionData']['userContext'] = {
                        'name': user_context.get('name'),
                        'email': user_context.get('email')
                    }
                    
                    # Only build full profile if we have emails
                    if emails and len(emails) > 0:
                        # Get all user emails (user email + primary account email)
                        user_emails = user_context.get('emails', [])
                        if not user_emails:
                            user_emails = [user_context.get('email')] if user_context.get('email') else []
                        user_emails_lower = [e.lower() for e in user_emails if e]
                        
                        # Extract email from "from" field (handles "Name <email>" format)
                        def extract_email_from_header(header: str) -> str:
                            """Extract email address from header like 'Name <email@domain.com>' or 'email@domain.com'"""
                            if not header:
                                return ''
                            # Try to find email in angle brackets
                            match = re.search(r'<([^>]+)>', header)
                            if match:
                                return match.group(1).lower()
                            # If no brackets, check if it's already an email
                            if '@' in header:
                                return header.strip().lower()
                            return ''
                        
                        # Filter emails sent by the user (check against all user emails)
                        user_sent_emails = []
                        for e in emails:
                            if not isinstance(e, dict):
                                continue
                            from_header = e.get('from', '') or ''
                            from_email = extract_email_from_header(from_header)
                            # Check if extracted email matches any of the user's emails (exact match)
                            if from_email and from_email in user_emails_lower:
                                user_sent_emails.append(e)
                        
                        logger.info(
                            f'  📊 Email analysis: {len(emails)} total emails, {len(user_sent_emails)} sent by user',
                            requestId=request_id,
                            userEmails=user_emails,
                            sentEmailCount=len(user_sent_emails)
                        )
                        
                        # Pass all emails (not just sent) so build_user_profile can extract both sent and received
                        if len(user_sent_emails) >= 5:
                            # Get files with content for user profiling
                            files_with_content = [f for f in files if isinstance(f, dict) and f.get('content')]
                            user_files = [
                                f for f in files_with_content
                                if isinstance(f, dict) and any(
                                    user_email.lower() in (f.get('ownerEmail') or f.get('owner') or '').lower()
                                    for user_email in user_emails_lower
                                )
                            ]
                            
                            # Ensure user_context has emails list for multi-account support
                            user_context_with_emails = {
                                **user_context,
                                'emails': user_emails  # Include all user emails
                            }
                            
                            # Get parallel client for web search (same as used for attendee research)
                            parallel_client = getattr(request.state, 'parallel_client', None) if request else None
                            
                            full_profile = await build_user_profile(
                                user_context_with_emails,
                                emails,  # Pass all emails so function can extract both sent and received
                                user_files,
                                calendar_events,
                                parallel_client,  # Pass parallel client for web search
                                request_id
                            )
                            
                            # Merge full profile with basic info
                            brief['_extractionData']['userContext'].update(full_profile)
                            
                            profile_parts = []
                            if brief['_extractionData']['userContext'].get('communicationStyle'):
                                profile_parts.append('communication style')
                            if brief['_extractionData']['userContext'].get('expertise'):
                                profile_parts.append('expertise')
                            if brief['_extractionData']['userContext'].get('biographicalInfo'):
                                profile_parts.append('biographical info')
                            if brief['_extractionData']['userContext'].get('workingPatterns'):
                                profile_parts.append('working patterns')
                            
                            logger.info(f'  ✓ User context built: {", ".join(profile_parts) if profile_parts else "basic info only"}', requestId=request_id)
                        else:
                            brief['_extractionData']['userContext']['note'] = f'Insufficient email data for profiling (need at least 5 sent emails, found {len(user_sent_emails)})'
                            logger.info(f'  ⚠️  Insufficient data for user profiling ({len(user_sent_emails)} sent emails)', requestId=request_id)
                    else:
                        brief['_extractionData']['userContext']['note'] = 'No email data available for profiling'
                        logger.info(f'  ⚠️  No emails available for user profiling', requestId=request_id)
                except Exception as error:
                    logger.error(f'  ❌ User profiling failed: {str(error)}', requestId=request_id)
                    brief['_extractionData']['userContext'] = {
                        'name': user_context.get('name'),
                        'email': user_context.get('email'),
                        'error': f'Profiling failed: {str(error)}'
                    }
            else:
                logger.info(f'  ⚠️  No user context available for profiling', requestId=request_id)

        # ===== SINGLE-ACCOUNT MODE (OLD - BACKWARD COMPATIBILITY) =====
        elif access_token:
            logger.info(f'\n🔑 Single-account mode: Using provided access token', requestId=request_id)
            # TODO: Implement single-account mode if needed
            raise HTTPException(status_code=501, detail='Single-account mode not yet implemented in Python version')

        # ===== NO AUTHENTICATION =====
        else:
            raise HTTPException(status_code=401, detail='Authentication required. Please provide session or access token.')

        # ===== AI ANALYSIS =====
        logger.info(f'\n🧠 Running original inline AI analysis...', requestId=request_id)

        try:
            # ===== STEP 1: RESEARCH ATTENDEES =====
            yield send_progress('researching_attendees', {'message': f'Researching {len(other_attendees)} attendees...'})
            
            # Check keep-alive
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': 'Researching attendees...'})
                last_keepalive = datetime.now()
            
            logger.info(f'\n👥 Researching attendees...', requestId=request_id)
            attendees_to_research = other_attendees if other_attendees else attendees

            logger.info(f'  📊 Researching {len(attendees_to_research)} attendees', requestId=request_id)

            # Get parallel client if available (from request state, set by middleware)
            parallel_client = getattr(request.state, 'parallel_client', None) if request else None
            
            if parallel_client:
                logger.info(f'  ✅ Parallel AI client available for web searches', requestId=request_id)
            else:
                logger.info(f'  ⚠️  Parallel AI client not available - web searches disabled', requestId=request_id)

            try:
                brief['attendees'] = await research_attendees(
                    attendees_to_research,
                    emails,
                    calendar_events,
                    meeting_title,
                    meeting_date_context,
                    user_context,
                    parallel_client,
                    request_id
                )
            except Exception as attendee_error:
                logger.error(f'  ❌ Attendee research failed: {str(attendee_error)}', requestId=request_id)
                # Fallback: create basic attendee entries
                brief['attendees'] = [
                    {
                        'name': att.get('displayName') or att.get('name') or (att.get('email') or att.get('emailAddress', '')).split('@')[0],
                        'email': att.get('email') or att.get('emailAddress'),
                        'company': None,
                        'title': 'Unknown',
                        'keyFacts': [],
                        'dataSource': 'basic',
                        'error': f'Research failed: {str(attendee_error)}'
                    }
                    for att in attendees_to_research
                    if att.get('email') or att.get('emailAddress')
                ]

            logger.info(f'  ✓ Research completed: {len(brief["attendees"])} attendees researched', requestId=request_id)
            
            # Check keep-alive after attendee research
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': 'Attendee research completed...'})
                last_keepalive = datetime.now()

            # Store attendee extraction data for UI
            brief['_extractionData']['attendeeExtractions'] = []
            for att in brief['attendees']:
                if not isinstance(att, dict):
                    continue
                    
                extraction_data = att.get('_extractionData', {})
                if not isinstance(extraction_data, dict):
                    extraction_data = {}
                
                brief['_extractionData']['attendeeExtractions'].append({
                    'name': att.get('name'),
                    'email': att.get('email'),
                    'company': att.get('company'),
                    'title': att.get('title'),
                    'keyFacts': att.get('keyFacts', []),
                    'extractionData': {
                        'emailsFrom': extraction_data.get('emailsFrom', 0),
                        'emailsTo': extraction_data.get('emailsTo', 0),
                        'emailFacts': extraction_data.get('emailFacts', []),
                        'webFacts': extraction_data.get('webFacts', []),
                        'webSearchResults': extraction_data.get('webSearchResults', []),
                        'emailData': extraction_data.get('emailData', [])
                    }
                })

            logger.info(
                f'  ✓ Processed {len(brief["attendees"])} attendees, {len(brief["_extractionData"]["attendeeExtractions"])} extraction records',
                requestId=request_id
            )

            # ===== STEP 1.5: DETECT MEETING PURPOSE AND AGENDA =====
            logger.info(f'\n  🧠 Detecting meeting purpose and agenda...', requestId=request_id)
            purpose_result = None
            try:
                purpose_result = await detect_meeting_purpose(
                    meeting,
                    attendees,
                    emails,
                    user_context,
                    request_id
                )
                logger.info(
                    f'  ✓ Purpose detected: {purpose_result.get("purpose", "unknown")}',
                    requestId=request_id,
                    confidence=purpose_result.get('confidence'),
                    source=purpose_result.get('source'),
                    hasAgenda=len(purpose_result.get('agenda', [])) > 0
                )
            except Exception as purpose_error:
                logger.error(f'  ❌ Purpose detection failed: {str(purpose_error)}', requestId=request_id)
                purpose_result = {
                    'purpose': None,
                    'agenda': [],
                    'confidence': 'low',
                    'source': 'error'
                }
            
            # Also run legacy context understanding for backward compatibility
            logger.info(f'\n  🧠 Understanding meeting context...', requestId=request_id)
            try:
                meeting_context = await understand_meeting_context(meeting, attendees, user_context)
                logger.info(f'  ✓ Meeting context understood: {meeting_context["confidence"]} confidence', requestId=request_id)
            except Exception as context_error:
                logger.error(f'  ❌ Meeting context understanding failed: {str(context_error)}', requestId=request_id)
                # Fallback: basic meeting context
                meeting_context = {
                    'understoodPurpose': purpose_result.get('purpose') if purpose_result else meeting_title,
                    'keyEntities': [],
                    'keyTopics': [],
                    'isSpecificMeeting': False,
                    'confidence': 'low',
                    'reasoning': f'Context analysis failed: {str(context_error)}'
                }
            logger.info(f'     Purpose: {meeting_context["understoodPurpose"][:100]}...', requestId=request_id)
            logger.info(f'     Key Entities: {", ".join(meeting_context["keyEntities"]) or "none"}', requestId=request_id)

            # ===== STEP 2: EMAIL RELEVANCE FILTERING + BATCH EXTRACTION =====
            yield send_progress('analyzing_emails', {'message': 'Analyzing email threads...'})
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': 'Processing emails...'})
                last_keepalive = datetime.now()
            
            try:
                relevant_emails, email_analysis, email_extraction_data = await filter_relevant_emails(
                    emails,
                    meeting_title,
                    meeting_date_context,
                    meeting_context,
                    user_context,
                    attendees,
                    request_id
                )
            except Exception as email_error:
                logger.error(f'  ❌ Email filtering failed: {str(email_error)}', requestId=request_id)
                # Fallback: use all emails
                relevant_emails = emails[:50]  # Limit to first 50
                email_analysis = 'Email filtering failed - showing all available emails.'
                email_extraction_data = {
                    'emailRelevanceReasoning': {},
                    'relevantContent': {'emails': relevant_emails[:10]}
                }

            brief['_extractionData']['emailRelevanceReasoning'] = email_extraction_data.get('emailRelevanceReasoning', {})
            brief['_extractionData']['meetingContext'] = meeting_context
            brief['_extractionData']['relevantContent']['emails'] = email_extraction_data.get('relevantContent', {}).get('emails', [])

            # ===== STEP 3: DOCUMENT ANALYSIS IN BATCHES OF 5 =====
            yield send_progress('analyzing_documents', {'message': 'Analyzing document content...'})
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': 'Processing documents...'})
                last_keepalive = datetime.now()
            
            try:
                document_analysis, files_with_content, document_extraction_data = await analyze_documents(
                    files,
                    meeting_title,
                    meeting_date_context,
                    meeting_context,
                    user_context,
                    attendees,
                    request_id
                )
            except Exception as doc_error:
                logger.error(f'  ❌ Document analysis failed: {str(doc_error)}', requestId=request_id)
                # Fallback: use all files
                files_with_content = [f for f in files if isinstance(f, dict) and f.get('content')][:10]
                document_analysis = 'Document analysis failed - showing all available files.'
                document_extraction_data = {
                    'fileRelevanceReasoning': {},
                    'documentStaleness': {},
                    'relevantContent': {'documents': files_with_content[:5]}
                }

            brief['_extractionData']['fileRelevanceReasoning'] = document_extraction_data.get('fileRelevanceReasoning', {})
            brief['_extractionData']['documentStaleness'] = document_extraction_data.get('documentStaleness', {})
            brief['_extractionData']['relevantContent']['documents'] = document_extraction_data.get('relevantContent', {}).get('documents', [])
            
            # Check keep-alive after document analysis
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': 'Document analysis completed...'})
                last_keepalive = datetime.now()

            # ===== STEP 4: COMPANY RESEARCH (placeholder) =====
            company_research = 'Company context available from emails and documents.'

            # ===== STEP 5: RELATIONSHIP ANALYSIS =====
            yield send_progress('analyzing_relationships', {'message': 'Analyzing working relationships...'})
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': 'Analyzing relationships...'})
                last_keepalive = datetime.now()
            
            logger.info(f'\n  🤝 Analyzing working relationships...', requestId=request_id)
            relationship_analysis = ''

            if relevant_emails or files_with_content:
                sample_emails = [
                    {
                        'subject': e.get('subject', ''),
                        'from': e.get('from', ''),
                        'to': e.get('to', ''),
                        'date': e.get('date', ''),
                        'bodyPreview': (e.get('body') or e.get('snippet') or '')[:500]
                    }
                    for e in relevant_emails[:10]
                ]

                sample_docs = [
                    {
                        'name': f.get('name', ''),
                        'contentPreview': (f.get('content') or '')[:2000],
                        'modifiedTime': str(f.get('modifiedTime')) if f.get('modifiedTime') else None  # Convert datetime to string
                    }
                    for f in files_with_content[:3]
                ]

                # Calculate interaction frequency
                interaction_frequency = {}
                for attendee in brief['attendees']:
                    attendee_email = (attendee.get('email') or '').lower()
                    if not attendee_email:
                        continue

                    email_count = sum(1 for e in relevant_emails if attendee_email in (e.get('from') or '').lower() or attendee_email in (e.get('to') or '').lower())
                    doc_count = sum(1 for f in files_with_content if attendee_email == (f.get('ownerEmail') or '').lower())

                    interaction_frequency[attendee.get('name', '')] = {
                        'emailInteractions': email_count,
                        'documentCollaborations': doc_count,
                        'totalInteractions': email_count + doc_count
                    }

                user_context_str = ''
                if user_context:
                    user_context_str = f'\n\nIMPORTANT: {user_context["formattedName"]} ({user_context["formattedEmail"]}) is the user you are preparing this brief for. Analyze relationships from {user_context["formattedName"]}\'s perspective. Focus on {user_context["formattedName"]}\'s relationships with others, not relationships between other attendees.'

                user_prefix_str = f"You are preparing a brief for {user_context['formattedName']} ({user_context['formattedEmail']}). " if user_context else ""
                user_line_str = f"User: {user_context['formattedName']} ({user_context['formattedEmail']})" if user_context else ""
                
                relationship_prompt = f'{user_prefix_str}Meeting: {meeting_title}{meeting_date_context}\n\n'
                relationship_prompt += f'{user_line_str}\n'
                attendee_list = ", ".join([f"{a.get('name')} ({a.get('email')})" for a in brief["attendees"]])
                relationship_prompt += f'Other Attendees: {attendee_list}{user_context_str}\n\n'
                relationship_prompt += f'INTERACTION FREQUENCY METRICS:\n{json.dumps(interaction_frequency, indent=2, default=str)}\n\n'
                relationship_prompt += f'EMAIL ANALYSIS SUMMARY:\n{email_analysis}\n\n'
                relationship_prompt += f'DOCUMENT ANALYSIS SUMMARY:\n{document_analysis}\n\n'
                relationship_prompt += f'RAW DATA SAMPLES (use these for specific examples and quotes):\n\n'
                relationship_prompt += f'Sample Emails ({len(sample_emails)}):\n{json.dumps(sample_emails, indent=2, default=str)}\n\n'
                relationship_prompt += f'Sample Documents ({len(sample_docs)}):\n{json.dumps(sample_docs, indent=2, default=str)}\n\n'
                relationship_prompt += f'Your task is to deeply analyze the WORKING RELATIONSHIPS{" between " + user_context["formattedName"] + " and the other attendees" if user_context else " between these people"}.\n'
                relationship_prompt += f'Use the interaction frequency metrics to understand communication patterns.\n'
                relationship_prompt += f'Use the raw data samples above for specific examples, quotes, and concrete details.\n'
                relationship_prompt += f'Use the summaries for overall context and patterns.\n\n'
                relationship_prompt += f'1. **{"How does " + user_context["formattedName"] + " know each attendee?" if user_context else "How do they know each other?"}** - Collaborative history, projects, duration\n'
                their_or_name = "their" if not user_context else user_context["formattedName"] + "'s"
                relationship_prompt += f'2. **What is {their_or_name} working dynamic with each attendee?** - Who makes decisions? Communication patterns? Trust level?\n'
                relationship_prompt += f'3. **What are the power dynamics?** - Authority? Hierarchy? Who drives the agenda?\n'
                relationship_prompt += f'4. **Are there any unresolved issues or tensions?** - Pending decisions? Blockers? Disagreements?\n\n'
                perspective_str = "the user's" if not user_context else user_context["formattedName"] + "'s"
                refer_to_str = "the user" if not user_context else user_context["formattedName"]
                relationship_prompt += f'Write a comprehensive 8-12 sentence analysis from {perspective_str} perspective. Be SPECIFIC: Reference actual emails with dates, mention specific documents, quote key exchanges. Use "you" to refer to {refer_to_str}.'

                relationship_analysis = await synthesize_results(
                    relationship_prompt,
                    {
                        'meetingTitle': meeting_title,
                        'emails': relevant_emails,
                        'documents': files_with_content,
                        'attendees': attendees
                    },
                    1200
                )

                relationship_analysis = relationship_analysis.strip() if relationship_analysis else 'Insufficient context to analyze working relationships.'
                logger.info(f'  ✓ Relationship analysis: {len(relationship_analysis)} chars', requestId=request_id)
            else:
                relationship_analysis = 'No relationship context available.'

            # ===== STEP 5: DEEP CONTRIBUTION ANALYSIS =====
            yield send_progress('analyzing_contributions', {'message': 'Analyzing contributions and roles...'})
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': 'Analyzing contributions...'})
                last_keepalive = datetime.now()
            
            logger.info(f'\n  👥 Analyzing contributions and roles...', requestId=request_id)
            contribution_analysis = ''

            if brief['attendees'] and (relevant_emails or files_with_content):
                contribution_data = {
                    'emails': [
                        {
                            'from': e.get('from', ''),
                            'to': e.get('to', ''),
                            'subject': e.get('subject', ''),
                            'date': str(e.get('date', '')) if e.get('date') else '',  # Ensure string
                            'bodyPreview': (e.get('body') or e.get('snippet') or '')[:500],
                            'attachments': e.get('attachments', [])
                        }
                        for e in relevant_emails[:50]
                    ],
                    'documents': [
                        {
                            'name': f.get('name', ''),
                            'owner': f.get('owner', ''),
                            'modifiedTime': str(f.get('modifiedTime')) if f.get('modifiedTime') else None,  # Convert datetime to string
                            'contentPreview': (f.get('content') or '')[:1000],
                            'sharedWith': f.get('sharedWith', [])
                        }
                        for f in files_with_content[:20]
                    ],
                    'calendarEvents': [
                        {
                            'summary': e.get('summary', ''),
                            'attendees': e.get('attendees', []),
                            'start': str(e.get('start')) if e.get('start') else None,  # Convert datetime to string
                            'description': e.get('description', '')
                        }
                        for e in calendar_events[:20]
                    ],
                    'attendees': [
                        {
                            'name': a.get('name', ''),
                            'email': a.get('email', ''),
                            'company': a.get('company', ''),
                            'keyFacts': a.get('keyFacts', [])
                        }
                        for a in brief['attendees']
                    ]
                }

                user_context_prefix = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). ' if user_context else ''
                
                important_msg = ""
                if user_context:
                    important_msg = f"IMPORTANT: {user_context['formattedName']} is the user you are preparing this brief for. Analyze contributions from {user_context['formattedName']}'s perspective. Focus on what {user_context['formattedName']} has contributed and how others contribute relative to {user_context['formattedName']}."
                
                focus_msg = ""
                if user_context:
                    focus_msg = f" Focus especially on {user_context['formattedName']}'s contributions."

                contribution_analysis_raw = await call_gpt([{
                    'role': 'system',
                    'content': (
                        f'{user_context_prefix}You are analyzing contributions and roles for meeting "{meeting_title}"{meeting_date_context}.\n\n'
                        f'{important_msg}\n\n'
                        f'Your goal: Deeply understand WHO is contributing WHAT and HOW.\n\n'
                        f'Analyze:\n'
                        f'1. **Individual Contributions**: What has each person contributed? (emails sent, documents created/shared, decisions made, questions asked){focus_msg}\n'
                        f'2. **Contribution Patterns**: Who initiates? Who responds? Who drives decisions? Who provides information?\n'
                        f'3. **Areas of Expertise**: What does each person specialize in? What topics do they discuss?\n'
                        f'4. **Influence & Authority**: Who has decision-making power? Who influences others? Who gets things done?\n'
                        f'5. **Collaboration Patterns**: {"How does " + user_context["formattedName"] + " collaborate with others?" if user_context else "Who works together?"} How do they collaborate? What are the working relationships?\n'
                        f'6. **Gaps & Missing Contributions**: {"What should " + user_context["formattedName"] + " contribute?" if user_context else "Who should be contributing but is not?"} What perspectives are missing?\n\n'
                        f'Return detailed JSON with contributions, collaboration networks, decision makers, information flow, and gaps.'
                    )
                }, {
                    'role': 'user',
                    'content': (
                        f'Meeting: "{meeting_title}"{meeting_date_context}\n'
                        f'Meeting Description: {meeting.get("description", "No description")}\n\n'
                        + (f'User: {user_context["formattedName"]} ({user_context["formattedEmail"]})\n' if user_context else '')
                        + f'Other Attendees: {", ".join([a.get("name") + " (" + a.get("email") + ")" for a in brief["attendees"]])}\n\n'
                        f'Email Data:\n{json.dumps(contribution_data["emails"], indent=2, default=str)}\n\n'
                        f'Document Data:\n{json.dumps(contribution_data["documents"], indent=2, default=str)}\n\n'
                        f'Calendar Data:\n{json.dumps(contribution_data["calendarEvents"], indent=2, default=str)}\n\n'
                        f'Analyze contributions deeply.'
                    )
                }], 4000)

                try:
                    parsed = safe_parse_json(contribution_analysis_raw)
                    if parsed and isinstance(parsed, dict):
                        user_context_prefix2 = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). ' if user_context else ''
                        perspective_str = "the user's" if not user_context else user_context["formattedName"] + "'s"
                        refer_to_str = "the user" if not user_context else user_context["formattedName"]
                        
                        # Ensure parsed dict is JSON-serializable (handle any datetime objects)
                        try:
                            parsed_json = json.dumps(parsed, default=str, ensure_ascii=False)
                        except (TypeError, ValueError) as json_err:
                            logger.warn(f'Failed to serialize contribution analysis JSON: {str(json_err)}', requestId=request_id)
                            # Fallback: convert to string representation
                            parsed_json = str(parsed)
                        
                        contribution_analysis = await call_gpt([{
                            'role': 'system',
                            'content': f'{user_context_prefix2}Convert this contribution analysis into a comprehensive narrative paragraph (8-12 sentences) that explains who contributes what and how, structured from {perspective_str} perspective. Use "you" to refer to {refer_to_str}.'
                        }, {
                            'role': 'user',
                            'content': f'Contribution Analysis:\n{parsed_json}\n\nCreate narrative explaining contributions and roles from {perspective_str} perspective.'
                        }], 2000)

                        contribution_analysis = contribution_analysis.strip() if contribution_analysis else 'Contribution analysis completed.'
                    elif parsed and isinstance(parsed, list):
                        # If it's a list, try to convert to narrative
                        contribution_analysis = 'Contribution analysis completed. (Received list format)'
                    else:
                        contribution_analysis = 'Contribution analysis completed.'
                except Exception as e:
                    logger.error(f'Failed to parse contribution analysis: {str(e)}', requestId=request_id)
                    logger.error(f'Raw response preview: {contribution_analysis_raw[:500] if contribution_analysis_raw else "None"}', requestId=request_id)
                    contribution_analysis = 'Contribution analysis completed.'

                logger.info(f'  ✓ Contribution analysis: {len(contribution_analysis)} chars', requestId=request_id)
            else:
                contribution_analysis = 'No contribution context available.'

            # ===== STEP 6: BROADER NARRATIVE SYNTHESIS =====
            yield send_progress('synthesizing_narrative', {'message': 'Synthesizing broader narrative...'})
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': 'Synthesizing narrative...'})
                last_keepalive = datetime.now()
            
            logger.info(f'\n  📖 Synthesizing broader narrative...', requestId=request_id)
            broader_narrative = ''

            if email_analysis or document_analysis or relationship_analysis:
                user_context_prefix = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). ' if user_context else ''
                perspective_str = "the user's" if not user_context else user_context["formattedName"] + "'s"
                
                broader_narrative = await synthesize_results(
                    (
                        f'{user_context_prefix}Create a comprehensive narrative that tells the complete story leading up to the meeting "{meeting_title}"{meeting_date_context} from {perspective_str} perspective.\n\n'
                        f'Use "you" to refer to {"the user" if not user_context else user_context["formattedName"]}.\n\n'
                        f'Email Context:\n{email_analysis}\n\n'
                        f'Document Context:\n{document_analysis}\n\n'
                        f'Relationship Context:\n{relationship_analysis}\n\n'
                        f'Weave these together into a cohesive 10-15 sentence narrative that explains the journey leading to this meeting.'
                    ),
                    {
                        'meetingTitle': meeting_title,
                        'emailAnalysis': email_analysis,
                        'documentAnalysis': document_analysis,
                        'relationshipAnalysis': relationship_analysis
                    },
                    1500
                )

                broader_narrative = broader_narrative.strip() if broader_narrative else 'Narrative synthesis completed.'
                logger.info(f'  ✓ Broader narrative: {len(broader_narrative)} chars', requestId=request_id)
            else:
                broader_narrative = 'No narrative context available.'

            # ===== STEP 7: TIMELINE BUILDING =====
            yield send_progress('building_timeline', {'message': 'Building interaction timeline...'})
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': 'Building timeline...'})
                last_keepalive = datetime.now()
            
            logger.info(f'\n  📅 Building intelligent interaction timeline...', requestId=request_id)
            limited_timeline = []

            # Collect all potential timeline events
            all_timeline_events = []

            for email in relevant_emails:
                if not isinstance(email, dict):
                    continue
                if email.get('date'):
                    try:
                        email_date = parse_email_date(email['date'])
                        if not email_date:
                            continue
                        participants = []
                        if email.get('from'):
                            from_match = re.match(r'^([^<]+)(?=\s*<)|^([^@]+@[^>]+)$', email['from'])
                            if from_match:
                                participants.append((from_match.group(1) or from_match.group(2) or email['from']).strip().replace('"', ''))

                        if email.get('to'):
                            to_emails = []
                            for e in email['to'].split(','):
                                e = e.strip()
                                if e:
                                    to_match = re.match(r'^([^<]+)(?=\s*<)|^([^@]+@[^>]+)$', e)
                                    if to_match:
                                        to_emails.append((to_match.group(1) or to_match.group(2) or e).strip())
                                    else:
                                        to_emails.append(e)
                            participants.extend(to_emails)

                        all_timeline_events.append({
                            'type': 'email',
                            'date': email_date.isoformat(),
                            'timestamp': email_date.timestamp(),
                            'subject': email.get('subject', 'No subject'),
                            'participants': list(set(participants)),
                            'snippet': (email.get('body') or email.get('snippet') or '')[:300],
                            'id': f'email-{email.get("id", int(email_date.timestamp()))}'
                        })
                    except Exception:
                        continue

            for file in files_with_content:
                if not isinstance(file, dict):
                    continue
                if file.get('modifiedTime'):
                    try:
                        modified_date = datetime.fromisoformat(file['modifiedTime'].replace('Z', '+00:00'))
                        all_timeline_events.append({
                            'type': 'document',
                            'date': modified_date.isoformat(),
                            'timestamp': modified_date.timestamp(),
                            'name': file.get('name', 'Unnamed document'),
                            'participants': [file.get('owner', 'Unknown')],
                            'action': 'modified',
                            'id': f'doc-{file.get("id", int(modified_date.timestamp()))}'
                        })
                    except Exception:
                        continue

            for event in calendar_events:
                if not isinstance(event, dict):
                    continue
                event_start_obj = event.get('start')
                if isinstance(event_start_obj, dict):
                    event_start = event_start_obj.get('dateTime') or event_start_obj.get('date')
                else:
                    event_start = event_start_obj
                if event_start:
                    try:
                        event_date = datetime.fromisoformat(str(event_start).replace('Z', '+00:00'))
                        event_attendees = [a.get('displayName') or a.get('email') or a.get('emailAddress') for a in event.get('attendees', []) if isinstance(a, dict) and (a.get('displayName') or a.get('email') or a.get('emailAddress'))]
                        all_timeline_events.append({
                            'type': 'meeting',
                            'date': event_date.isoformat(),
                            'timestamp': event_date.timestamp(),
                            'name': event.get('summary') or event.get('title') or 'Past Meeting',
                            'participants': event_attendees,
                            'action': 'scheduled',
                            'id': f'meeting-{event.get("id", int(event_date.timestamp()))}'
                        })
                    except Exception:
                        continue

            # Sort chronologically and filter to last 6 months
            all_timeline_events = [e for e in all_timeline_events if isinstance(e, dict)]
            all_timeline_events.sort(key=lambda e: e.get('timestamp', 0), reverse=True)
            six_months_ago = datetime.utcnow() - timedelta(days=180)
            recent_events = [e for e in all_timeline_events if isinstance(e, dict) and e.get('timestamp') and datetime.fromtimestamp(e['timestamp']) >= six_months_ago]

            # Limit to 100 events for analysis
            events_to_analyze = recent_events[:100]

            if events_to_analyze:
                user_context_prefix3 = f'You are preparing a brief for {user_context.get("formattedName", "the user")} ({user_context.get("formattedEmail", "")}). ' if user_context and isinstance(user_context, dict) else ''
                
                important_msg3 = ""
                if user_context and isinstance(user_context, dict):
                    user_name = user_context.get('formattedName', 'the user')
                    important_msg3 = f"IMPORTANT: {user_name} is the user you are preparing this brief for. Focus on events that are relevant to {user_name}'s understanding of this meeting."
                
                perspective_str3 = "the user's" if not (user_context and isinstance(user_context, dict)) else user_context.get("formattedName", "the user") + "'s"
                
                timeline_analysis = await call_gpt([{
                    'role': 'system',
                    'content': (
                        f'{user_context_prefix3}You are analyzing timeline events to understand WHY the meeting "{meeting_title}"{meeting_date_context} is happening from {perspective_str3} perspective.\n\n'
                        f'{important_msg3}\n\n'
                        f'Your goal: Identify the MOST IMPORTANT events that tell the story leading up to this meeting.\n\n'
                        f'Return JSON array of event IDs (from the "id" field) that should be included, ordered by importance:\n'
                        f'{{"important_event_ids": ["id1", "id2", ...], "reasoning": "Brief explanation"}}'
                    )
                }, {
                    'role': 'user',
                    'content': (
                        f'Meeting: "{meeting_title}"{meeting_date_context}\n'
                        f'Meeting Description: {meeting.get("description", "No description provided")}\n'
                        + (f'User: {user_context["formattedName"]} ({user_context["formattedEmail"]})\n' if user_context else '')
                        + f'Other Attendees: {", ".join([a.get("name") for a in brief["attendees"]])}\n\n'
                        f'Timeline Events ({len(events_to_analyze)} events):\n'
                        + '\n\n'.join([
                            f'[{i}] ID: {e.get("id", "")}\nType: {e.get("type", "")}\nDate: {e.get("date", "")}\n'
                            + (f'Subject: {e.get("subject", "")}\nFrom/To: {", ".join(e.get("participants", []))}\nContent: {e.get("snippet", "")[:200]}' if isinstance(e, dict) and e.get('type') == 'email' else '')
                            + (f'Document: {e.get("name", "")}\nOwner: {", ".join(e.get("participants", []))}' if isinstance(e, dict) and e.get('type') == 'document' else '')
                            + (f'Meeting: {e.get("name", "")}\nAttendees: {", ".join(e.get("participants", []))}' if isinstance(e, dict) and e.get('type') == 'meeting' else '')
                            + '\n---'
                            for i, e in enumerate(events_to_analyze)
                            if isinstance(e, dict)
                        ])
                    )
                }], 4000)

                try:
                    parsed = safe_parse_json(timeline_analysis)
                    if parsed and isinstance(parsed, dict):
                        important_ids = parsed.get('important_event_ids', [])
                        event_map = {e['id']: e for e in events_to_analyze if isinstance(e, dict) and 'id' in e}
                        prioritized_timeline = [event_map[id] for id in important_ids if id in event_map]
                        remaining_events = [e for e in events_to_analyze if isinstance(e, dict) and e.get('id') not in important_ids]
                        prioritized_timeline.extend(remaining_events[:50])
                    else:
                        prioritized_timeline = [e for e in events_to_analyze if isinstance(e, dict)][:100]
                except Exception as e:
                    logger.error(f'Failed to parse timeline analysis: {str(e)}', requestId=request_id)
                    prioritized_timeline = [e for e in events_to_analyze if isinstance(e, dict)][:100]
            else:
                prioritized_timeline = []

            # Add meeting date as reference point
            if meeting_date and isinstance(meeting_date, dict):
                participants = []
                if brief.get('attendees') and isinstance(brief['attendees'], list):
                    participants = [a.get('name') for a in brief['attendees'] if isinstance(a, dict)]
                prioritized_timeline.append({
                    'type': 'meeting',
                    'date': meeting_date.get('iso', ''),
                    'timestamp': meeting_date.get('date', datetime.utcnow()).timestamp() if isinstance(meeting_date.get('date'), datetime) else datetime.utcnow().timestamp(),
                    'name': meeting_title,
                    'participants': participants,
                    'action': 'scheduled',
                    'isReference': True,
                    'id': 'current-meeting'
                })

            # Final sort by timestamp (only dict items)
            prioritized_timeline = [e for e in prioritized_timeline if isinstance(e, dict)]
            prioritized_timeline.sort(key=lambda e: e.get('timestamp', 0), reverse=True)
            limited_timeline = prioritized_timeline[:100]

            # Analyze trend
            try:
                timeline_trend = analyze_trend(limited_timeline)
                if not isinstance(timeline_trend, dict):
                    timeline_trend = {'trend': 'unknown', 'velocity': 0}
            except Exception as e:
                logger.error(f'Failed to analyze timeline trend: {str(e)}', requestId=request_id)
                timeline_trend = {'trend': 'unknown', 'velocity': 0}
            brief['_timelineTrend'] = timeline_trend
            logger.info(f'  ✓ Timeline built: {len(limited_timeline)} events', requestId=request_id)

            # ===== STEP 7: RECOMMENDATIONS =====
            logger.info(f'\n  💡 Generating meeting-specific recommendations...', requestId=request_id)
            user_context_prefix4 = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). ' if user_context else ''
            
            important_msg4 = ""
            if user_context:
                important_msg4 = f'IMPORTANT: {user_context["formattedName"]} is the user you are preparing this brief for. Provide recommendations for {user_context["formattedName"]}. Use "you" to refer to {user_context["formattedName"]}.'
            
            refer_to_str4 = "the user" if not user_context else user_context["formattedName"]
            
            recommendations = await synthesize_results(
                (
                    f'{user_context_prefix4}You are preparing for the meeting: "{meeting_title}"{meeting_date_context}\n\n'
                    f'{important_msg4}\n\n'
                    f'Based on the LOCAL CONTEXT (emails, documents, attendee info), provide 3-5 strategic recommendations for {refer_to_str4} for THIS SPECIFIC MEETING.\n\n'
                    f'Context available:\n'
                    f'- Attendees: {" | ".join([a.get("name", "") + " (" + str(a.get("keyFacts", [])[:2]) + ")" for a in brief.get("attendees", []) if isinstance(a, dict)]) if isinstance(brief, dict) else ""}\n'
                    f'- Email discussions: {email_analysis[:500]}\n'
                    f'- Documents: {document_analysis[:500]}\n\n'
                    f'Each recommendation should:\n'
                    f'1. Reference SPECIFIC information from the context above\n'
                    f'2. Be actionable for {refer_to_str4} in THIS meeting\n'
                    f'3. Connect multiple data points\n'
                    f'4. Be 25-70 words\n'
                    f'5. Use "you" to refer to {refer_to_str4}\n\n'
                    f'Return ONLY a JSON array.'
                ),
                {
                    'meetingTitle': meeting.get('summary', ''),
                    'emailContext': email_analysis,
                    'docContext': document_analysis,
                    'attendeeContext': brief['attendees']
                },
                900
            )

            parsed_recommendations = []
            try:
                parsed = safe_parse_json(recommendations)
                if isinstance(parsed, list):
                    parsed_recommendations = [
                        r if isinstance(r, str) else (r.get('text') or r.get('recommendation') or str(r))
                        for r in parsed[:5]
                        if r and (isinstance(r, str) or isinstance(r, dict))
                    ]
            except Exception:
                pass

            logger.info(f'  ✓ Generated {len(parsed_recommendations)} recommendations', requestId=request_id)

            # ===== STEP 8: ACTION ITEMS =====
            logger.info(f'\n  ✅ Generating action items...', requestId=request_id)
            user_context_prefix5 = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). ' if user_context else ''
            refer_to_str5 = "the user" if not user_context else user_context["formattedName"]
            
            action_items = await synthesize_results(
                f'{user_context_prefix5}Based on the meeting context, generate 3-7 specific action items for {refer_to_str5}.\n\n'
                f'Return ONLY a JSON array of action items. Each should be 15-50 words and reference specific context.',
                {
                    'meetingTitle': meeting_title,
                    'emailAnalysis': email_analysis,
                    'documentAnalysis': document_analysis,
                    'recommendations': parsed_recommendations
                },
                800
            )

            parsed_action_items = []
            try:
                parsed = safe_parse_json(action_items)
                if isinstance(parsed, list):
                    parsed_action_items = [
                        item if isinstance(item, str) else (item.get('text') or item.get('action') or str(item))
                        for item in parsed[:7]
                        if item and isinstance(item, str) and len(item) > 10
                    ]
            except Exception:
                pass

            logger.info(f'  ✓ Generated {len(parsed_action_items)} action items', requestId=request_id)

            # ===== STEP 9: EXECUTIVE SUMMARY (LAST - with full context) =====
            yield send_progress('generating_summary', {'message': 'Generating executive summary...'})
            if datetime.now() - last_keepalive >= KEEPALIVE_INTERVAL:
                yield send_progress('keepalive', {'message': 'Generating summary...'})
                last_keepalive = datetime.now()
            
            brief['summary'] = await generate_executive_summary(
                meeting,
                meeting_title,
                meeting_date_context,
                meeting_date,
                brief['attendees'],
                email_analysis,
                document_analysis,
                relationship_analysis,
                contribution_analysis,
                broader_narrative,
                limited_timeline,
                timeline_trend,
                parsed_recommendations,
                user_context,
                request_id
            )

            # ===== ASSEMBLE FINAL BRIEF =====
            brief['emailAnalysis'] = email_analysis
            brief['documentAnalysis'] = document_analysis
            brief['companyResearch'] = company_research
            brief['relationshipAnalysis'] = relationship_analysis
            brief['contributionAnalysis'] = contribution_analysis
            brief['broaderNarrative'] = broader_narrative
            brief['timeline'] = limited_timeline
            brief['recommendations'] = parsed_recommendations
            brief['actionItems'] = parsed_action_items

            # Add purpose and agenda if detected
            if purpose_result:
                brief['purpose'] = purpose_result.get('purpose')
                brief['agenda'] = purpose_result.get('agenda', [])
                brief['purposeConfidence'] = purpose_result.get('confidence')
                brief['purposeSource'] = purpose_result.get('source')
                brief['contextEmail'] = purpose_result.get('contextEmail')
            
            # Add stats
            brief['stats'] = {
                'emailCount': len(emails),
                'relevantEmailCount': len(relevant_emails),
                'fileCount': len(files),
                'filesWithContentCount': len(files_with_content),
                'calendarEventCount': len(calendar_events),
                'attendeeCount': len(brief['attendees']),
                'multiAccount': bool(user and user.get('id')),
                'accountCount': len(accounts),
                'multiAccountStats': brief.get('_multiAccountStats')
            }

            logger.info(
                f'\n✅ Original inline analysis complete! {len(brief["attendees"])} attendees, {len(relevant_emails)} relevant emails, {len(files_with_content)} analyzed docs, {len(limited_timeline)} timeline events',
                requestId=request_id
            )

            # Yield final result
            result = {'type': 'complete', **brief}
            yield json.dumps(result) + '\n'
            return

        except Exception as analysis_error:
            logger.error(f'❌ AI analysis failed: {str(analysis_error)}', requestId=request_id)
            logger.error(f'Stack trace: {str(analysis_error.__traceback__)}', requestId=request_id)

            # FALLBACK: Return raw context if analysis fails
            # Safely get multiAccountStats if brief exists
            multi_account_stats = {}
            try:
                multi_account_stats = brief.get('_multiAccountStats', {}) if isinstance(brief, dict) else {}
            except (NameError, AttributeError):
                # brief might not be initialized yet, use empty dict
                multi_account_stats = {}
            
            error_result = {
                'type': 'complete',
                'success': True,
                'context': {
                    'emails': emails,
                    'files': files,
                    'calendarEvents': calendar_events,
                    'meeting': meeting,
                    'attendees': attendees
                },
                'stats': {
                    'emailCount': len(emails),
                    'fileCount': len(files),
                    'calendarEventCount': len(calendar_events),
                    'attendeeCount': len(attendees),
                    'multiAccount': bool(user and user.get('id')),
                    'accountCount': len(accounts),
                    'multiAccountStats': multi_account_stats
                },
                'error': 'AI analysis failed, showing raw data',
                'analysisError': str(analysis_error)
            }
            yield json.dumps(error_result) + '\n'
            return

    except HTTPException as http_error:
        # Yield HTTP error as JSON
        error_result = {
            'type': 'error',
            'statusCode': http_error.status_code,
            'error': http_error.detail if isinstance(http_error.detail, str) else http_error.detail.get('error', 'HTTP Error'),
            'message': http_error.detail if isinstance(http_error.detail, str) else http_error.detail.get('message', str(http_error.detail))
        }
        yield json.dumps(error_result) + '\n'
        return
    except Exception as error:
        logger.error(
            f'Error preparing meeting brief',
            requestId=request_id,
            error=str(error),
            errorType=type(error).__name__,
            stack=str(error.__traceback__) if hasattr(error, '__traceback__') else None,
            meetingTitle=meeting.get('summary') or meeting.get('title') if meeting else 'unknown',
            userId=user.get('id') if user else 'anonymous'
        )

        error_result = {
            'type': 'error',
            'statusCode': 500,
            'error': 'Meeting preparation failed',
            'message': str(error),
            'errorType': type(error).__name__,
            'requestId': request_id
        }
        yield json.dumps(error_result) + '\n'
        return


class MeetingPurposeRequest(BaseModel):
    meeting: Dict[str, Any]
    attendees: List[Dict[str, Any]]


@router.post('/detect-meeting-purpose')
async def detect_meeting_purpose_endpoint(
    request_body: MeetingPurposeRequest,
    user: Optional[Dict[str, Any]] = Depends(optional_auth),
    request: Request = None
):
    """
    Detect meeting purpose from calendar event and attendees
    Runs BEFORE email fetching - uses only calendar info and LLM inference
    """
    request_id = getattr(request.state, 'request_id', 'unknown') if request else 'unknown'
    
    try:
        meeting = request_body.meeting
        attendees = request_body.attendees or []
        
        # Get user context
        user_context = await get_user_context(user, request_id) if user else None
        
        # Call detect_meeting_purpose with empty emails list (runs Stage 1 and Stage 3 only)
        purpose_result = await detect_meeting_purpose(
            meeting,
            attendees,
            [],  # Empty emails list - purpose detection without email context
            user_context,
            request_id
        )
        
        logger.info(
            f'Meeting purpose detected',
            requestId=request_id,
            purpose=purpose_result.get('purpose'),
            confidence=purpose_result.get('confidence'),
            source=purpose_result.get('source'),
            meetingTitle=meeting.get('summary') or meeting.get('title')
        )
        
        return {
            'success': True,
            'purpose': purpose_result.get('purpose'),
            'agenda': purpose_result.get('agenda', []),
            'confidence': purpose_result.get('confidence', 'low'),
            'source': purpose_result.get('source', 'uncertain'),
            'contextEmail': purpose_result.get('contextEmail')
        }
    except Exception as error:
        logger.error(
            f'Error detecting meeting purpose',
            requestId=request_id,
            error=str(error),
            errorType=type(error).__name__,
            meetingTitle=meeting.get('summary') if 'meeting' in locals() else 'unknown'
        )
        raise HTTPException(
            status_code=500,
            detail={
                'error': 'Meeting purpose detection failed',
                'message': str(error)
            }
        )


@router.post('/prep-meeting')
async def prep_meeting(
    request_body: MeetingPrepRequest,
    user: Optional[Dict[str, Any]] = Depends(optional_auth),
    request: Request = None
):
    """
    Prepare meeting brief with AI analysis
    Supports both multi-account (authenticated) and single-account (token-based) modes
    Uses streaming response to prevent Railway timeout
    """
    request_id = getattr(request.state, 'request_id', 'unknown') if request else 'unknown'
    
    return StreamingResponse(
        _generate_prep_response(request_body, user, request, request_id),
        media_type='application/x-ndjson'  # Newline-delimited JSON for streaming
    )