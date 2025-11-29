"""
Meetings Routes

Meeting preparation endpoints with AI analysis
Supports multi-account and single-account modes
"""

import asyncio
import json
import re
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.middleware.auth import optional_auth
from app.db.queries.accounts import get_accounts_by_user_id
from app.services.logger import logger
from app.services.gpt_service import call_gpt, safe_parse_json, synthesize_results
from app.services.user_context import get_user_context, filter_user_from_attendees
from app.services.token_refresh import ensure_all_tokens_valid
from app.services.multi_account_fetcher import (
    fetch_all_account_context,
    fetch_calendar_from_all_accounts,
    merge_and_deduplicate_calendar_events
)
from app.services.attendee_research import research_attendees
from app.services.email_relevance import filter_relevant_emails
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


@router.post('/prep-meeting')
async def prep_meeting(
    request_body: MeetingPrepRequest,
    user: Optional[Dict[str, Any]] = Depends(optional_auth),
    request: Request = None
):
    """
    Prepare meeting brief with AI analysis
    Supports both multi-account (authenticated) and single-account (token-based) modes
    """
    request_id = getattr(request.state, 'request_id', 'unknown') if request else 'unknown'

    try:
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

        logger.info(
            f'Starting meeting prep request',
            requestId=request_id,
            meetingTitle=meeting_title,
            meetingDate=meeting_date.get('readable') if meeting_date else 'unknown',
            attendeeCount=len(attendees),
            hasAccessToken=bool(access_token),
            userId=user.get('id') if user else 'anonymous',
            userName=user_context.get('name') if user_context else 'unknown'
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
            logger.info(f'\n🚀 Multi-account mode: Fetching from all connected accounts', requestId=request_id)

            accounts = await get_accounts_by_user_id(user['id'])
            if not accounts:
                raise HTTPException(status_code=400, detail='No accounts connected. Please connect at least one Google account.')

            # Validate all tokens
            token_validation_result = await ensure_all_tokens_valid(accounts)
            if not token_validation_result.get('validAccounts'):
                failed_accounts = token_validation_result.get('failedAccounts', [])
                all_revoked = all(f.get('isRevoked') for f in failed_accounts)
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
                                'isRevoked': a.get('isRevoked')
                            }
                            for a in failed_accounts
                        ]
                    }
                )

            accounts = token_validation_result['validAccounts']

            # Fetch context from ALL accounts in parallel
            context_result = await fetch_all_account_context(accounts, attendees, meeting)
            emails = context_result.get('emails', [])
            files = context_result.get('files', [])
            brief['_multiAccountStats'] = context_result.get('accountStats', {})

            # Fetch calendar events
            calendar_result = await fetch_calendar_from_all_accounts(accounts, attendees, meeting)
            calendar_events = merge_and_deduplicate_calendar_events(calendar_result)

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
            logger.info(f'\n👥 Researching attendees...', requestId=request_id)
            attendees_to_research = other_attendees if other_attendees else attendees

            # Get parallel client if available (from request state)
            parallel_client = getattr(request.state, 'parallel_client', None) if request else None

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

            # Store attendee extraction data for UI
            brief['_extractionData']['attendeeExtractions'] = [
                {
                    'name': att.get('name'),
                    'email': att.get('email'),
                    'company': att.get('company'),
                    'title': att.get('title'),
                    'keyFacts': att.get('keyFacts', []),
                    'extractionData': {
                        'emailsFrom': att.get('_extractionData', {}).get('emailsFrom', 0),
                        'emailsTo': att.get('_extractionData', {}).get('emailsTo', 0),
                        'emailFacts': att.get('_extractionData', {}).get('emailFacts', []),
                        'webFacts': att.get('_extractionData', {}).get('webFacts', []),
                        'webSearchResults': att.get('_extractionData', {}).get('webSearchResults', []),
                        'emailData': att.get('_extractionData', {}).get('emailData', [])
                    }
                }
                for att in brief['attendees']
            ]

            logger.info(f'  ✓ Processed {len(brief["attendees"])} attendees', requestId=request_id)

            # ===== STEP 1.5: UNDERSTAND MEETING CONTEXT BEFORE FILTERING =====
            logger.info(f'\n  🧠 Understanding meeting context...', requestId=request_id)
            meeting_context = await understand_meeting_context(meeting, attendees, user_context)
            logger.info(f'  ✓ Meeting context understood: {meeting_context["confidence"]} confidence', requestId=request_id)
            logger.info(f'     Purpose: {meeting_context["understoodPurpose"][:100]}...', requestId=request_id)
            logger.info(f'     Key Entities: {", ".join(meeting_context["keyEntities"]) or "none"}', requestId=request_id)

            # ===== STEP 2: EMAIL RELEVANCE FILTERING + BATCH EXTRACTION =====
            relevant_emails, email_analysis, email_extraction_data = await filter_relevant_emails(
                emails,
                meeting_title,
                meeting_date_context,
                meeting_context,
                user_context,
                attendees,
                request_id
            )

            brief['_extractionData']['emailRelevanceReasoning'] = email_extraction_data.get('emailRelevanceReasoning', {})
            brief['_extractionData']['meetingContext'] = meeting_context
            brief['_extractionData']['relevantContent']['emails'] = email_extraction_data.get('relevantContent', {}).get('emails', [])

            # ===== STEP 3: DOCUMENT ANALYSIS IN BATCHES OF 5 =====
            document_analysis, files_with_content, document_extraction_data = await analyze_documents(
                files,
                meeting_title,
                meeting_date_context,
                meeting_context,
                user_context,
                attendees,
                request_id
            )

            brief['_extractionData']['fileRelevanceReasoning'] = document_extraction_data.get('fileRelevanceReasoning', {})
            brief['_extractionData']['documentStaleness'] = document_extraction_data.get('documentStaleness', {})
            brief['_extractionData']['relevantContent']['documents'] = document_extraction_data.get('relevantContent', {}).get('documents', [])

            # ===== STEP 4: COMPANY RESEARCH (placeholder) =====
            company_research = 'Company context available from emails and documents.'

            # ===== STEP 5: RELATIONSHIP ANALYSIS =====
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
                        'modifiedTime': f.get('modifiedTime')
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
                relationship_prompt += f'INTERACTION FREQUENCY METRICS:\n{json.dumps(interaction_frequency, indent=2)}\n\n'
                relationship_prompt += f'EMAIL ANALYSIS SUMMARY:\n{email_analysis}\n\n'
                relationship_prompt += f'DOCUMENT ANALYSIS SUMMARY:\n{document_analysis}\n\n'
                relationship_prompt += f'RAW DATA SAMPLES (use these for specific examples and quotes):\n\n'
                relationship_prompt += f'Sample Emails ({len(sample_emails)}):\n{json.dumps(sample_emails, indent=2)}\n\n'
                relationship_prompt += f'Sample Documents ({len(sample_docs)}):\n{json.dumps(sample_docs, indent=2)}\n\n'
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
            logger.info(f'\n  👥 Analyzing contributions and roles...', requestId=request_id)
            contribution_analysis = ''

            if brief['attendees'] and (relevant_emails or files_with_content):
                contribution_data = {
                    'emails': [
                        {
                            'from': e.get('from', ''),
                            'to': e.get('to', ''),
                            'subject': e.get('subject', ''),
                            'date': e.get('date', ''),
                            'bodyPreview': (e.get('body') or e.get('snippet') or '')[:500],
                            'attachments': e.get('attachments', [])
                        }
                        for e in relevant_emails[:50]
                    ],
                    'documents': [
                        {
                            'name': f.get('name', ''),
                            'owner': f.get('owner', ''),
                            'modifiedTime': f.get('modifiedTime'),
                            'contentPreview': (f.get('content') or '')[:1000],
                            'sharedWith': f.get('sharedWith', [])
                        }
                        for f in files_with_content[:20]
                    ],
                    'calendarEvents': [
                        {
                            'summary': e.get('summary', ''),
                            'attendees': e.get('attendees', []),
                            'start': e.get('start'),
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
                        f'Email Data:\n{json.dumps(contribution_data["emails"], indent=2)}\n\n'
                        f'Document Data:\n{json.dumps(contribution_data["documents"], indent=2)}\n\n'
                        f'Calendar Data:\n{json.dumps(contribution_data["calendarEvents"], indent=2)}\n\n'
                        f'Analyze contributions deeply.'
                    )
                }], 4000)

                try:
                    parsed = safe_parse_json(contribution_analysis_raw)
                    if parsed and isinstance(parsed, dict):
                        user_context_prefix2 = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). ' if user_context else ''
                        perspective_str = "the user's" if not user_context else user_context["formattedName"] + "'s"
                        refer_to_str = "the user" if not user_context else user_context["formattedName"]
                        
                        contribution_analysis = await call_gpt([{
                            'role': 'system',
                            'content': f'{user_context_prefix2}Convert this contribution analysis into a comprehensive narrative paragraph (8-12 sentences) that explains who contributes what and how, structured from {perspective_str} perspective. Use "you" to refer to {refer_to_str}.'
                        }, {
                            'role': 'user',
                            'content': f'Contribution Analysis:\n{json.dumps(parsed, indent=2)}\n\nCreate narrative explaining contributions and roles from {perspective_str} perspective.'
                        }], 2000)

                        contribution_analysis = contribution_analysis.strip() if contribution_analysis else 'Contribution analysis completed.'
                    else:
                        contribution_analysis = 'Contribution analysis completed.'
                except Exception as e:
                    logger.error(f'Failed to parse contribution analysis: {str(e)}', requestId=request_id)
                    contribution_analysis = 'Contribution analysis completed.'

                logger.info(f'  ✓ Contribution analysis: {len(contribution_analysis)} chars', requestId=request_id)
            else:
                contribution_analysis = 'No contribution context available.'

            # ===== STEP 6: BROADER NARRATIVE SYNTHESIS =====
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
            logger.info(f'\n  📅 Building intelligent interaction timeline...', requestId=request_id)
            limited_timeline = []

            # Collect all potential timeline events
            all_timeline_events = []

            for email in relevant_emails:
                if email.get('date'):
                    try:
                        email_date = datetime.fromisoformat(email['date'].replace('Z', '+00:00'))
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
                event_start = event.get('start', {}).get('dateTime') or event.get('start', {}).get('date') or event.get('start')
                if event_start:
                    try:
                        event_date = datetime.fromisoformat(str(event_start).replace('Z', '+00:00'))
                        event_attendees = [a.get('displayName') or a.get('email') or a.get('emailAddress') for a in event.get('attendees', []) if a.get('displayName') or a.get('email') or a.get('emailAddress')]
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
            all_timeline_events.sort(key=lambda e: e.get('timestamp', 0), reverse=True)
            six_months_ago = datetime.utcnow() - timedelta(days=180)
            recent_events = [e for e in all_timeline_events if e.get('timestamp') and datetime.fromtimestamp(e['timestamp']) >= six_months_ago]

            # Limit to 100 events for analysis
            events_to_analyze = recent_events[:100]

            if events_to_analyze:
                user_context_prefix3 = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). ' if user_context else ''
                
                important_msg3 = ""
                if user_context:
                    important_msg3 = f"IMPORTANT: {user_context['formattedName']} is the user you are preparing this brief for. Focus on events that are relevant to {user_context['formattedName']}'s understanding of this meeting."
                
                perspective_str3 = "the user's" if not user_context else user_context["formattedName"] + "'s"
                
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
                            f'[{i}] ID: {e["id"]}\nType: {e["type"]}\nDate: {e["date"]}\n'
                            + (f'Subject: {e.get("subject", "")}\nFrom/To: {", ".join(e.get("participants", []))}\nContent: {e.get("snippet", "")[:200]}' if e['type'] == 'email' else '')
                            + (f'Document: {e.get("name", "")}\nOwner: {", ".join(e.get("participants", []))}' if e['type'] == 'document' else '')
                            + (f'Meeting: {e.get("name", "")}\nAttendees: {", ".join(e.get("participants", []))}' if e['type'] == 'meeting' else '')
                            + '\n---'
                            for i, e in enumerate(events_to_analyze)
                        ])
                    )
                }], 4000)

                try:
                    parsed = safe_parse_json(timeline_analysis)
                    important_ids = parsed.get('important_event_ids', []) if parsed else []
                    event_map = {e['id']: e for e in events_to_analyze}
                    prioritized_timeline = [event_map[id] for id in important_ids if id in event_map]
                    remaining_events = [e for e in events_to_analyze if e['id'] not in important_ids]
                    prioritized_timeline.extend(remaining_events[:50])
                except Exception as e:
                    logger.error(f'Failed to parse timeline analysis: {str(e)}', requestId=request_id)
                    prioritized_timeline = events_to_analyze[:100]
            else:
                prioritized_timeline = []

            # Add meeting date as reference point
            if meeting_date:
                prioritized_timeline.append({
                    'type': 'meeting',
                    'date': meeting_date['iso'],
                    'timestamp': meeting_date['date'].timestamp(),
                    'name': meeting_title,
                    'participants': [a.get('name') for a in brief['attendees']],
                    'action': 'scheduled',
                    'isReference': True,
                    'id': 'current-meeting'
                })

            # Final sort by timestamp
            prioritized_timeline.sort(key=lambda e: e.get('timestamp', 0), reverse=True)
            limited_timeline = prioritized_timeline[:100]

            # Analyze trend
            timeline_trend = analyze_trend(limited_timeline)
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
                    f'- Attendees: {" | ".join([a.get("name") + " (" + str(a.get("keyFacts", [])[:2]) + ")" for a in brief["attendees"]])}\n'
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

            return brief

        except Exception as analysis_error:
            logger.error(f'❌ AI analysis failed: {str(analysis_error)}', requestId=request_id)
            logger.error(f'Stack trace: {str(analysis_error.__traceback__)}', requestId=request_id)

            # FALLBACK: Return raw context if analysis fails
            return {
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
                    'multiAccountStats': brief.get('_multiAccountStats')
                },
                'error': 'AI analysis failed, showing raw data',
                'analysisError': str(analysis_error)
            }

    except Exception as error:
        logger.error(
            f'Error preparing meeting brief',
            requestId=request_id,
            error=str(error),
            stack=str(error.__traceback__),
            meetingTitle=meeting.get('summary') or meeting.get('title') if meeting else 'unknown',
            userId=user.get('id') if user else 'anonymous'
        )

        raise HTTPException(
            status_code=500,
            detail={
                'error': 'Meeting preparation failed',
                'message': str(error),
                'requestId': request_id
            }
        )