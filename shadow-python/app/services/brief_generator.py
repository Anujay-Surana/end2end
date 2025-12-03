"""
Brief Generator Service

Generates meeting briefs with one-liner summaries for the cron job
"""

import json
from typing import Dict, Any, Optional, List
from datetime import datetime

from app.services.logger import logger
from app.services.gpt_service import call_gpt, safe_parse_json
from app.db.queries.accounts import get_accounts_by_user_id
from app.services.token_refresh import ensure_all_tokens_valid
from app.services.multi_account_fetcher import fetch_all_account_context
from app.services.user_context import get_user_context
from app.services.attendee_research import research_attendees
from app.services.email_relevance import filter_relevant_emails
from app.services.document_analyzer import analyze_documents


async def generate_one_liner(
    meeting: Dict[str, Any],
    attendees: List[Dict[str, Any]],
    brief_data: Dict[str, Any],
    user_context: Optional[Dict[str, Any]]
) -> str:
    """
    Generate a concise one-liner summary for a meeting
    """
    meeting_title = meeting.get('summary') or meeting.get('title') or 'Untitled Meeting'
    meeting_description = meeting.get('description', '')
    
    # Build context for one-liner generation
    context_parts = []
    
    if brief_data.get('summary'):
        context_parts.append(f"Executive Summary: {brief_data['summary'][:500]}")
    
    if brief_data.get('purpose'):
        context_parts.append(f"Purpose: {brief_data['purpose']}")
    
    if attendees:
        attendee_names = [a.get('displayName') or a.get('name') or a.get('email', '').split('@')[0] for a in attendees[:5]]
        context_parts.append(f"Attendees: {', '.join(attendee_names)}")
    
    try:
        user_prefix = f"For {user_context['formattedName']}: " if user_context else ""
        
        one_liner = await call_gpt([
            {
                'role': 'system',
                'content': (
                    'You are an executive assistant creating a ONE-LINER summary for a meeting. '
                    'The summary should be:\n'
                    '- Maximum 15-20 words\n'
                    '- Capture the core purpose/topic\n'
                    '- Be actionable and specific\n'
                    '- Written in active voice\n'
                    'Return ONLY the one-liner, no quotes or formatting.'
                )
            },
            {
                'role': 'user',
                'content': (
                    f'Meeting: {meeting_title}\n'
                    f'Description: {meeting_description[:200] if meeting_description else "None"}\n\n'
                    f'Context:\n{chr(10).join(context_parts)}\n\n'
                    f'{user_prefix}Generate a one-liner summary.'
                )
            }
        ], max_tokens=100)
        
        # Clean up the response
        one_liner = one_liner.strip().strip('"').strip("'")
        
        # Ensure it's not too long
        if len(one_liner) > 150:
            one_liner = one_liner[:147] + '...'
        
        return one_liner
        
    except Exception as error:
        logger.error(f'Error generating one-liner: {str(error)}')
        # Fallback: create a simple one-liner from meeting title
        return f"Meeting about {meeting_title[:50]}"


async def generate_brief_with_one_liner(
    user_id: str,
    meeting: Dict[str, Any],
    attendees: List[Dict[str, Any]],
    request_id: str
) -> Optional[Dict[str, Any]]:
    """
    Generate a full meeting brief with a one-liner summary
    
    This is a simplified version of the full prep-meeting flow,
    optimized for batch processing in the cron job.
    
    Returns:
        {
            'one_liner': str,
            'full_brief': dict
        }
    """
    meeting_title = meeting.get('summary') or meeting.get('title') or 'Untitled Meeting'
    
    logger.info(
        f'Generating brief for: {meeting_title}',
        requestId=request_id,
        userId=user_id,
        meetingId=meeting.get('id')
    )
    
    try:
        # Get user accounts
        accounts = await get_accounts_by_user_id(user_id)
        if not accounts:
            logger.warning(f'No accounts for user {user_id}', requestId=request_id)
            return None
        
        # Validate tokens
        token_result = await ensure_all_tokens_valid(accounts)
        valid_accounts = token_result.get('validAccounts', [])
        
        if not valid_accounts:
            logger.warning(f'No valid accounts for user {user_id}', requestId=request_id)
            return None
        
        # Get user context
        user = {'id': user_id}
        user_context = await get_user_context(user, request_id)
        
        # Fetch context from all accounts (emails, files)
        context_result = await fetch_all_account_context(valid_accounts, attendees, meeting)
        emails = context_result.get('emails', [])
        files = context_result.get('files', [])
        
        # Initialize brief structure
        brief = {
            'summary': '',
            'attendees': [],
            'purpose': None,
            'agenda': [],
            'emailAnalysis': '',
            'documentAnalysis': '',
            'recommendations': [],
            'actionItems': [],
            'stats': {
                'emailCount': len(emails),
                'fileCount': len(files),
                'attendeeCount': len(attendees)
            }
        }
        
        # Research attendees (simplified)
        try:
            brief['attendees'] = await research_attendees(
                attendees,
                emails[:50],  # Limit emails for speed
                [],  # No calendar events needed for batch
                meeting_title,
                '',
                user_context,
                None,  # No parallel client for cron
                None,
                request_id
            )
        except Exception as att_error:
            logger.warning(f'Attendee research failed: {str(att_error)}', requestId=request_id)
            brief['attendees'] = [
                {
                    'name': a.get('displayName') or a.get('name') or (a.get('email') or '').split('@')[0],
                    'email': a.get('email') or a.get('emailAddress'),
                    'title': 'Unknown',
                    'keyFacts': []
                }
                for a in attendees
            ]
        
        # Filter relevant emails (simplified)
        try:
            relevant_emails, email_analysis, _ = await filter_relevant_emails(
                emails[:100],  # Limit for speed
                meeting_title,
                '',
                None,
                user_context,
                attendees,
                None,
                request_id
            )
            brief['emailAnalysis'] = email_analysis
        except Exception as email_error:
            logger.warning(f'Email filtering failed: {str(email_error)}', requestId=request_id)
            brief['emailAnalysis'] = 'Email analysis not available.'
        
        # Analyze documents (simplified)
        try:
            document_analysis, files_with_content, _ = await analyze_documents(
                files[:20],  # Limit for speed
                meeting_title,
                '',
                None,
                user_context,
                attendees,
                request_id
            )
            brief['documentAnalysis'] = document_analysis
        except Exception as doc_error:
            logger.warning(f'Document analysis failed: {str(doc_error)}', requestId=request_id)
            brief['documentAnalysis'] = 'Document analysis not available.'
        
        # Generate executive summary
        try:
            user_prefix = f"You are preparing a brief for {user_context['formattedName']}. " if user_context else ""
            
            summary_response = await call_gpt([
                {
                    'role': 'system',
                    'content': (
                        f'{user_prefix}Generate a concise executive summary for a meeting. '
                        'The summary should:\n'
                        '- Be 3-5 sentences\n'
                        '- Cover the key purpose and objectives\n'
                        '- Mention key attendees if relevant\n'
                        '- Highlight any critical points from email/document context'
                    )
                },
                {
                    'role': 'user',
                    'content': (
                        f'Meeting: {meeting_title}\n'
                        f'Description: {meeting.get("description", "None")[:300]}\n\n'
                        f'Email Context: {brief["emailAnalysis"][:500]}\n\n'
                        f'Document Context: {brief["documentAnalysis"][:500]}\n\n'
                        f'Attendees: {", ".join([a.get("name", "") for a in brief["attendees"][:5]])}\n\n'
                        'Generate the executive summary.'
                    )
                }
            ], max_tokens=500)
            
            brief['summary'] = summary_response.strip()
        except Exception as summary_error:
            logger.warning(f'Summary generation failed: {str(summary_error)}', requestId=request_id)
            brief['summary'] = f'Meeting: {meeting_title}. Review attendee information and relevant context before the meeting.'
        
        # Generate recommendations
        try:
            recs_response = await call_gpt([
                {
                    'role': 'system',
                    'content': 'Generate 3-5 actionable recommendations for this meeting. Return as a JSON array of strings.'
                },
                {
                    'role': 'user',
                    'content': (
                        f'Meeting: {meeting_title}\n'
                        f'Summary: {brief["summary"]}\n'
                        'Generate recommendations.'
                    )
                }
            ], max_tokens=300)
            
            parsed_recs = safe_parse_json(recs_response)
            if isinstance(parsed_recs, list):
                brief['recommendations'] = [str(r) for r in parsed_recs[:5]]
        except Exception as rec_error:
            logger.warning(f'Recommendations failed: {str(rec_error)}', requestId=request_id)
        
        # Generate one-liner
        one_liner = await generate_one_liner(meeting, attendees, brief, user_context)
        
        logger.info(
            f'Brief generated successfully for: {meeting_title}',
            requestId=request_id,
            oneLiner=one_liner[:50]
        )
        
        return {
            'one_liner': one_liner,
            'full_brief': brief
        }
        
    except Exception as error:
        logger.error(
            f'Error generating brief: {str(error)}',
            requestId=request_id,
            userId=user_id,
            meetingId=meeting.get('id')
        )
        return None

