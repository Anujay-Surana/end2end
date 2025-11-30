"""
Meeting Purpose Detection Pipeline

Multi-stage detection of meeting purpose and agenda:
1. Direct inference from calendar event
2. Attendee-matching to find context email
3. LLM-based educated guess
4. User confirmation/correction (if uncertain)
"""

from typing import Dict, Any, Optional, List
from datetime import datetime
from app.services.gpt_service import call_gpt, safe_parse_json
from app.services.logger import logger
from app.services.email_relevance import filter_relevant_emails


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
        - contextEmail: Optional email that provided context
    """
    result = {
        'purpose': None,
        'agenda': [],
        'confidence': 'low',
        'source': 'uncertain',
        'contextEmail': None
    }
    
    # Stage 1: Direct inference from calendar event
    calendar_result = _infer_from_calendar(meeting)
    if calendar_result['confidence'] == 'high':
        logger.info(
            'Purpose detected from calendar event',
            requestId=request_id,
            purpose=calendar_result['purpose'],
            confidence=calendar_result['confidence']
        )
        return {**result, **calendar_result, 'source': 'calendar'}
    
    # Stage 2: Attendee-matching to find context email
    if emails and attendees:
        email_result = await _find_context_email(
            meeting,
            attendees,
            emails,
            user_context,
            request_id
        )
        if email_result['confidence'] in ['high', 'medium']:
            logger.info(
                'Purpose detected from context email',
                requestId=request_id,
                purpose=email_result['purpose'],
                confidence=email_result['confidence']
            )
            return {**result, **email_result, 'source': 'email'}
    
    # Stage 3: LLM-based educated guess
    llm_result = await _llm_educated_guess(
        meeting,
        attendees,
        emails[:10] if emails else [],  # Limit to top 10 emails for speed
        request_id
    )
    
    if llm_result['confidence'] == 'high':
        logger.info(
            'Purpose detected via LLM',
            requestId=request_id,
            purpose=llm_result['purpose'],
            confidence=llm_result['confidence']
        )
        return {**result, **llm_result, 'source': 'llm'}
    
    # If still uncertain, return uncertain result
    if llm_result['purpose']:
        return {**result, **llm_result, 'source': 'llm', 'confidence': 'low'}
    
    return {**result, 'source': 'uncertain'}


def _infer_from_calendar(meeting: Dict[str, Any]) -> Dict[str, Any]:
    """
    Stage 1: Direct inference from calendar event title/description
    
    Returns:
        Dict with purpose, agenda, confidence
    """
    summary = (meeting.get('summary') or meeting.get('title') or '').strip()
    description = (meeting.get('description') or '').strip()
    
    if not summary:
        return {'purpose': None, 'agenda': [], 'confidence': 'low'}
    
    # Check for explicit agenda markers
    agenda_items = []
    if description:
        # Look for numbered lists, bullet points, or "Agenda:" markers
        lines = description.split('\n')
        in_agenda_section = False
        for line in lines:
            line = line.strip()
            if not line:
                continue
            
            # Detect agenda section
            if 'agenda' in line.lower() and ':' in line:
                in_agenda_section = True
                continue
            
            # Extract agenda items (numbered or bulleted)
            if in_agenda_section or line.startswith(('-', '*', '•', '1.', '2.', '3.')):
                # Clean up the line
                cleaned = line.lstrip('-*•0123456789. ').strip()
                if cleaned and len(cleaned) > 3:
                    agenda_items.append(cleaned)
                    in_agenda_section = True
    
    # Extract purpose from title (simple heuristics)
    purpose = None
    confidence = 'low'
    
    # Common meeting patterns
    if any(word in summary.lower() for word in ['standup', 'stand-up', 'daily sync']):
        purpose = 'Daily standup/sync'
        confidence = 'high'
    elif any(word in summary.lower() for word in ['1:1', 'one-on-one', 'one on one']):
        purpose = '1-on-1 meeting'
        confidence = 'high'
    elif any(word in summary.lower() for word in ['review', 'retrospective', 'retro']):
        purpose = 'Review/retrospective'
        confidence = 'high'
    elif any(word in summary.lower() for word in ['planning', 'planning meeting']):
        purpose = 'Planning meeting'
        confidence = 'high'
    elif any(word in summary.lower() for word in ['interview', 'screening']):
        purpose = 'Interview'
        confidence = 'high'
    elif any(word in summary.lower() for word in ['demo', 'demonstration']):
        purpose = 'Product demo'
        confidence = 'high'
    else:
        # Use title as purpose if it's descriptive
        if len(summary) > 10 and len(summary) < 100:
            purpose = summary
            confidence = 'medium'
    
    return {
        'purpose': purpose,
        'agenda': agenda_items[:10],  # Limit to 10 items
        'confidence': confidence
    }


async def _find_context_email(
    meeting: Dict[str, Any],
    attendees: List[Dict[str, Any]],
    emails: List[Dict[str, Any]],
    user_context: Optional[Dict[str, Any]],
    request_id: str = None
) -> Dict[str, Any]:
    """
    Stage 2: Find context email using attendee overlap
    
    Uses 75%/50% overlap rule:
    - <5 attendees: require ~75% overlap
    - >=5 attendees: require at least 50% overlap
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
    if attendee_count < 5:
        overlap_threshold = 0.75  # 75% overlap
    else:
        overlap_threshold = 0.50  # 50% overlap
    
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
    
    # Use the best matching email
    best_match = matching_emails[0]['email']
    
    # Extract purpose and agenda from email
    subject = (best_match.get('subject') or '').strip()
    body = (best_match.get('body') or best_match.get('snippet') or '').strip()
    
    # Simple extraction: look for agenda in email body
    agenda_items = []
    if body:
        lines = body.split('\n')
        in_agenda = False
        for line in lines[:50]:  # Check first 50 lines
            line = line.strip()
            if not line:
                continue
            
            if 'agenda' in line.lower() and ':' in line:
                in_agenda = True
                continue
            
            if in_agenda and (line.startswith(('-', '*', '•', '1.', '2.')) or line[0].isdigit()):
                cleaned = line.lstrip('-*•0123456789. ').strip()
                if cleaned and len(cleaned) > 3:
                    agenda_items.append(cleaned)
                    if len(agenda_items) >= 10:
                        break
    
    # Use subject or first line of body as purpose
    purpose = subject
    if not purpose and body:
        first_line = body.split('\n')[0].strip()
        if len(first_line) < 200:
            purpose = first_line
    
    confidence = 'high' if matching_emails[0]['overlap'] >= 0.75 else 'medium'
    
    return {
        'purpose': purpose,
        'agenda': agenda_items[:10],
        'confidence': confidence,
        'contextEmail': {
            'id': best_match.get('id'),
            'subject': subject,
            'date': best_match.get('date')
        }
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


async def _llm_educated_guess(
    meeting: Dict[str, Any],
    attendees: List[Dict[str, Any]],
    emails: List[Dict[str, Any]],
    request_id: str = None
) -> Dict[str, Any]:
    """
    Stage 3: LLM-based educated guess
    
    Uses GPT to infer purpose from meeting title, description, and email context
    """
    summary = (meeting.get('summary') or meeting.get('title') or '').strip()
    description = (meeting.get('description') or '').strip()
    
    if not summary:
        return {'purpose': None, 'agenda': [], 'confidence': 'low'}
    
    # Prepare email context (limit to 3 most relevant)
    email_context = ''
    if emails:
        email_samples = emails[:3]
        email_context = '\n\nRelevant emails:\n'
        for e in email_samples:
            subject = e.get('subject', '')
            snippet = (e.get('snippet') or e.get('body') or '')[:200]
            email_context += f'- Subject: {subject}\n  Preview: {snippet}\n'
    
    # Prepare attendee context
    attendee_names = []
    for att in attendees[:5]:
        if isinstance(att, dict):
            name = att.get('displayName') or att.get('name') or att.get('email')
            if name:
                attendee_names.append(name)
    
    attendee_context = ', '.join(attendee_names) if attendee_names else 'Unknown attendees'
    
    # Call GPT for purpose inference
    try:
        response = await call_gpt([{
            'role': 'system',
            'content': """You are analyzing a calendar meeting to determine its purpose and agenda.

Return JSON:
{
  "purpose": "Clear, concise purpose statement" | null,
  "agenda": ["item 1", "item 2"] | [],
  "confidence": "high" | "medium" | "low"
}

Rules:
- Only extract agenda items if explicitly mentioned (don't fabricate)
- Purpose should be specific and actionable
- Confidence should be "high" only if purpose is very clear from title/description
- If uncertain, return "low" confidence"""
        }, {
            'role': 'user',
            'content': f"""Meeting Title: {summary}
Description: {description or '(none)'}
Attendees: {attendee_context}
{email_context}

What is the purpose of this meeting? Extract agenda items if explicitly provided."""
        }], 600)  # Lower token limit for speed
        
        parsed = safe_parse_json(response)
        if isinstance(parsed, dict):
            return {
                'purpose': parsed.get('purpose'),
                'agenda': parsed.get('agenda', [])[:10],
                'confidence': parsed.get('confidence', 'low')
            }
    except Exception as e:
        logger.warn(f'LLM purpose inference failed: {str(e)}', requestId=request_id)
    
    # Fallback: use title as purpose
    return {
        'purpose': summary if len(summary) < 100 else summary[:100] + '...',
        'agenda': [],
        'confidence': 'low'
    }

