"""
Meeting Purpose Detection Pipeline

Multi-stage detection of meeting purpose and agenda:
1. LLM inference from calendar event
2. Attendee-matching to find context emails (LLM extracted)
3. Final LLM aggregation of stage outputs
4. User confirmation/correction (if uncertain)
"""

import asyncio
from typing import Dict, Any, Optional, List
from datetime import datetime
from app.services.gpt_service import call_gpt, safe_parse_json
from app.services.logger import logger


async def detect_meeting_purpose(
    meeting: Dict[str, Any],
    attendees: List[Dict[str, Any]],
    emails: List[Dict[str, Any]],
    user_context: Optional[Dict[str, Any]] = None,
    request_id: str = None
) -> Dict[str, Any]:
    """
    Detect meeting purpose using multi-stage pipeline
    
    Args:
        meeting: Calendar event object
        attendees: List of attendee objects
        emails: List of emails to search for context
        user_context: Optional user context
        request_id: Request ID for logging
    
    Returns:
        Dict with:
        - purpose: str (detected purpose)
        - agenda: List[str] (itemized agenda if found)
        - confidence: 'high', 'medium', 'low'
        - source: 'calendar', 'email', 'llm', 'uncertain'
        - contextEmail: Optional email(s) that provided context
    """
    result = {
        'purpose': None,
        'agenda': [],
        'confidence': 'low',
        'source': 'uncertain',
        'contextEmail': None
    }

    # Run calendar + email stages in parallel
    calendar_task = asyncio.create_task(_llm_infer_from_calendar(meeting, attendees, request_id))
    email_task = asyncio.create_task(_find_context_email(meeting, attendees, emails, user_context, request_id))

    calendar_result, email_result = await asyncio.gather(calendar_task, email_task, return_exceptions=True)

    # Handle possible exceptions
    if isinstance(calendar_result, Exception):
        logger.warn(f'Calendar purpose inference failed: {calendar_result}', requestId=request_id)
        calendar_result = {'purpose': None, 'agenda': [], 'confidence': 'low', 'source': 'calendar', 'contextEmail': None}
    if isinstance(email_result, Exception):
        logger.warn(f'Email purpose inference failed: {email_result}', requestId=request_id)
        email_result = {'purpose': None, 'agenda': [], 'confidence': 'low', 'source': 'email', 'contextEmail': None}

    # Final aggregation using both stage outputs
    final_result = await _final_llm_aggregation(meeting, calendar_result, email_result, request_id)

    # If final LLM returns something meaningful, prefer it
    if final_result.get('purpose'):
        logger.info(
            'Purpose detected via final aggregation',
            requestId=request_id,
            purpose=final_result.get('purpose'),
            confidence=final_result.get('confidence'),
            source=final_result.get('source')
        )
        return {**result, **final_result}

    # Fallbacks: prefer email result, then calendar
    if email_result.get('purpose'):
        return {**result, **email_result, 'source': 'email'}
    if calendar_result.get('purpose'):
        return {**result, **calendar_result, 'source': 'calendar'}

    return {**result, 'source': 'uncertain'}


async def _llm_infer_from_calendar(
    meeting: Dict[str, Any],
    attendees: List[Dict[str, Any]],
    request_id: str = None
) -> Dict[str, Any]:
    """
    Stage 1: LLM inference from calendar event (title/description/attendees)
    """
    summary = (meeting.get('summary') or meeting.get('title') or '').strip()
    description = (meeting.get('description') or '').strip()

    if not summary and not description:
        return {'purpose': None, 'agenda': [], 'confidence': 'low'}

    attendee_names = []
    for att in attendees[:5]:
        if isinstance(att, dict):
            name = att.get('displayName') or att.get('name') or att.get('email')
            if name:
                attendee_names.append(name)

    attendee_context = ', '.join(attendee_names) if attendee_names else 'Unknown attendees'

    try:
        response = await call_gpt([
            {
                'role': 'system',
                'content': """You are analyzing a calendar event to determine meeting purpose and agenda.
Return compact JSON:
{"purpose":"...", "agenda":["..."], "confidence":"high|medium|low"}
- Do NOT fabricate agenda items; only include if explicitly present.
- Purpose should be concise and actionable.
- Confidence high only when purpose is clear from provided text."""
            },
            {
                'role': 'user',
                'content': f"""Calendar Title: {summary or "(none)"}
Description: {description or "(none)"}
Attendees: {attendee_context}

Return JSON only."""
            }
        ], max_tokens=400)

        parsed = safe_parse_json(response)
        if isinstance(parsed, dict):
            return {
                'purpose': parsed.get('purpose'),
                'agenda': (parsed.get('agenda') or [])[:10],
                'confidence': parsed.get('confidence', 'low'),
                'source': 'calendar'
            }
    except Exception as e:
        logger.warn(f'LLM calendar inference failed: {str(e)}', requestId=request_id)

    # Fallback: use title as low-confidence purpose
    fallback_purpose = summary if summary else None
    return {
        'purpose': fallback_purpose,
        'agenda': [],
        'confidence': 'low',
        'source': 'calendar'
    }


async def _find_context_email(
    meeting: Dict[str, Any],
    attendees: List[Dict[str, Any]],
    emails: List[Dict[str, Any]],
    user_context: Optional[Dict[str, Any]],
    request_id: str = None
) -> Dict[str, Any]:
    """
    Stage 2: Find context emails using attendee overlap and LLM extraction
    
    Uses strict overlap criteria:
    - <=4 attendees: require 100% overlap (ALL attendees must match)
    - >=5 attendees: require 75% overlap (at least 75% must match)
    """
    if not emails or not attendees:
        return {'purpose': None, 'agenda': [], 'confidence': 'low', 'contextEmail': None}
    
    # Extract attendee emails
    attendee_emails = []
    for att in attendees:
        if isinstance(att, dict):
            email = att.get('email') or att.get('emailAddress')
            if email:
                attendee_emails.append(email.lower())
    
    if not attendee_emails:
        return {'purpose': None, 'agenda': [], 'confidence': 'low', 'contextEmail': None}
    
    # Calculate overlap threshold
    attendee_count = len(attendee_emails)
    if attendee_count <= 4:
        overlap_threshold = 1.0  # 100% - all attendees must match
    else:
        overlap_threshold = 0.75  # 75% - at least 75% must match
    
    # Find emails with matching attendees
    matching_emails = []
    for email in emails:
        if not isinstance(email, dict):
            continue
        
        # Extract email participants
        email_from = (email.get('from') or '').lower()
        email_to = [e.lower() for e in (email.get('to') or [])]
        email_cc = [e.lower() for e in (email.get('cc') or [])]
        email_participants = set([email_from] + email_to + email_cc)
        
        # Calculate overlap
        matching = [e for e in attendee_emails if e in email_participants]
        overlap_ratio = len(matching) / attendee_count if attendee_count > 0 else 0
        
        if overlap_ratio >= overlap_threshold:
            matching_emails.append({
                'email': email,
                'overlap': overlap_ratio,
                'matching_count': len(matching)
            })
    
    if not matching_emails:
        return {'purpose': None, 'agenda': [], 'confidence': 'low', 'contextEmail': None}
    
    # Sort by overlap ratio (highest first), then by date (most recent first)
    matching_emails.sort(key=lambda x: (-x['overlap'], _get_email_date(x['email'])), reverse=False)

    # Use up to top 5 overlapping emails for LLM context
    selected = matching_emails[:5]
    email_blocks = []
    context_emails_meta = []
    for idx, item in enumerate(selected):
        email_obj = item['email']
        subject = (email_obj.get('subject') or '').strip()
        body = (email_obj.get('body') or email_obj.get('snippet') or '').strip()
        trimmed_body = body[:1200]  # cap to keep prompt light
        email_blocks.append(
            f"Email {idx + 1} | overlap={item['overlap']:.2f}, matching={item['matching_count']}\n"
            f"Subject: {subject or '(no subject)'}\n"
            f"Body:\n{trimmed_body or '(no body)'}"
        )
        context_emails_meta.append({
            'id': email_obj.get('id'),
            'subject': subject,
            'date': email_obj.get('date'),
            'overlap': item['overlap'],
            'matchingCount': item['matching_count']
        })

    email_context = "\n\n".join(email_blocks)
    summary = (meeting.get('summary') or meeting.get('title') or '').strip()

    try:
        response = await call_gpt([
            {
                'role': 'system',
                'content': """You are extracting meeting purpose/agenda from related emails.
Return compact JSON:
{"purpose":"...", "agenda":["..."], "confidence":"high|medium|low"}
- Use the provided emails only; do NOT invent agenda items.
- Consider overlap scores when judging confidence."""
            },
            {
                'role': 'user',
                'content': f"""Meeting Title: {summary or "(none)"}
Attendee overlap emails (highest first):
{email_context}

Return JSON only."""
            }
        ], max_tokens=600)

        parsed = safe_parse_json(response)
        if isinstance(parsed, dict):
            return {
                'purpose': parsed.get('purpose'),
                'agenda': (parsed.get('agenda') or [])[:10],
                'confidence': parsed.get('confidence', 'low'),
                'contextEmail': context_emails_meta,
                'source': 'email'
            }
    except Exception as e:
        logger.warn(f'LLM email inference failed: {str(e)}', requestId=request_id)

    # Fallback: use the best email subject/body first line
    best_match = selected[0]['email']
    subject = (best_match.get('subject') or '').strip()
    body = (best_match.get('body') or best_match.get('snippet') or '').strip()
    fallback_purpose = subject or (body.split('\n')[0].strip() if body else None)

    return {
        'purpose': fallback_purpose,
        'agenda': [],
        'confidence': 'low',
        'contextEmail': context_emails_meta,
        'source': 'email'
    }


def _get_email_date(email: Dict[str, Any]) -> datetime:
    """Helper to get email date for sorting"""
    date_str = email.get('date') or email.get('internalDate')
    if not date_str:
        return datetime.min
    
    try:
        from app.services.google_api import parse_email_date
        parsed = parse_email_date(date_str)
        return parsed if parsed else datetime.min
    except Exception:
        return datetime.min


async def _final_llm_aggregation(
    meeting: Dict[str, Any],
    calendar_result: Dict[str, Any],
    email_result: Dict[str, Any],
    request_id: str = None
) -> Dict[str, Any]:
    """
    Stage 3: Final LLM aggregation using outputs from calendar + email stages
    """
    summary = (meeting.get('summary') or meeting.get('title') or '').strip()
    description = (meeting.get('description') or '').strip()

    calendar_json = {
        'purpose': calendar_result.get('purpose'),
        'agenda': calendar_result.get('agenda', []),
        'confidence': calendar_result.get('confidence')
    }
    email_json = {
        'purpose': email_result.get('purpose'),
        'agenda': email_result.get('agenda', []),
        'confidence': email_result.get('confidence')
    }

    try:
        response = await call_gpt([
            {
                'role': 'system',
                'content': """You are combining two purpose/agenda hypotheses (calendar + emails) to pick the final meeting purpose.
Return JSON:
{"purpose":"...", "agenda":["..."], "confidence":"high|medium|low", "source":"calendar|email|combined"}
Rules:
- Prefer explicit agenda items provided; do NOT invent.
- If both sources disagree, choose the more specific + confident one.
- Use "combined" when merging elements from both."""
            },
            {
                'role': 'user',
                'content': f"""Meeting Title: {summary or "(none)"}
Description: {description or "(none)"}

Calendar hypothesis: {calendar_json}
Email hypothesis: {email_json}

Return final JSON only."""
            }
        ], max_tokens=400)

        parsed = safe_parse_json(response)
        if isinstance(parsed, dict):
            return {
                'purpose': parsed.get('purpose'),
                'agenda': (parsed.get('agenda') or [])[:10],
                'confidence': parsed.get('confidence', 'low'),
                'source': parsed.get('source', 'llm'),
                'contextEmail': email_result.get('contextEmail')
            }
    except Exception as e:
        logger.warn(f'Final LLM aggregation failed: {str(e)}', requestId=request_id)

    return {'purpose': None, 'agenda': [], 'confidence': 'low', 'source': 'llm', 'contextEmail': email_result.get('contextEmail')}

