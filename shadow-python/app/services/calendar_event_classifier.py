"""
Calendar Event Classifier

Distinguishes actual meetings from calendar noise (travel, reminders, public events, etc.).
Uses an LLM-first approach aligned with product rules, with deterministic fallback.
"""

import json
from typing import Dict, Any, Optional, List
from app.services.logger import logger
from app.services.gpt_service import call_gpt, safe_parse_json


# Event types
EVENT_TYPE_MEETING = 'meeting'
EVENT_TYPE_PUBLIC_EVENT = 'public_event'
EVENT_TYPE_PERSONAL_REMINDER = 'personal_reminder'
EVENT_TYPE_LEISURE = 'leisure'
EVENT_TYPE_TRAVEL = 'travel'
EVENT_TYPE_UNKNOWN = 'unknown'

ALLOWED_EVENT_TYPES = {
    EVENT_TYPE_MEETING,
    EVENT_TYPE_PUBLIC_EVENT,
    EVENT_TYPE_PERSONAL_REMINDER,
    EVENT_TYPE_LEISURE,
    EVENT_TYPE_TRAVEL,
    EVENT_TYPE_UNKNOWN
}


def _normalize_classification(raw: Any) -> Optional[Dict[str, Any]]:
    """Normalize LLM output into the expected schema."""
    if not isinstance(raw, dict):
        return None

    event_type = raw.get('type') or EVENT_TYPE_UNKNOWN
    if event_type not in ALLOWED_EVENT_TYPES:
        event_type = EVENT_TYPE_UNKNOWN

    should_prep = bool(raw.get('shouldPrep', False))
    prep_depth = raw.get('prepDepth')
    if prep_depth not in ['full', 'minimal', 'none']:
        prep_depth = 'full' if should_prep else 'minimal'

    confidence = raw.get('confidence', 'medium')
    reason = raw.get('reason') or 'LLM classification'

    return {
        'type': event_type,
        'confidence': confidence,
        'shouldPrep': should_prep,
        'prepDepth': prep_depth,
        'reason': reason
    }


def _extract_event_features(
    event: Dict[str, Any],
    user_emails_lower: List[str]
) -> Dict[str, Any]:
    """Extract normalized features used by LLM prompt and fallback rules."""
    summary_raw = (event.get('summary') or event.get('title') or '').strip()
    description_raw = (event.get('description') or '').strip()
    summary = summary_raw.lower()
    description = description_raw.lower()
    attendees = event.get('attendees', []) or []
    organizer = event.get('organizer', {})

    organizer_email = ''
    if isinstance(organizer, dict):
        organizer_email = (organizer.get('email') or '').lower()
    elif isinstance(organizer, str):
        organizer_email = organizer.lower()

    is_organizer = any(u == organizer_email for u in user_emails_lower if organizer_email)

    attendee_count = 0
    user_is_attendee = False
    attendee_summaries: List[Dict[str, Any]] = []

    if isinstance(attendees, list):
        for att in attendees:
            if not isinstance(att, dict):
                continue
            att_email_raw = (att.get('email') or att.get('emailAddress') or '')
            att_email = att_email_raw.lower()
            if att_email:
                attendee_count += 1
                if any(u == att_email for u in user_emails_lower):
                    user_is_attendee = True
            attendee_summaries.append({
                'name': att.get('displayName') or att.get('name'),
                'email': att_email_raw,
                'responseStatus': att.get('responseStatus')
            })

    return {
        'summary_raw': summary_raw,
        'description_raw': description_raw,
        'summary': summary,
        'description': description,
        'attendee_count': attendee_count,
        'user_is_attendee': user_is_attendee,
        'attendees': attendee_summaries,
        'organizer': organizer,
        'organizer_email': organizer_email,
        'is_organizer': is_organizer
    }


def _rule_based_fallback(
    features: Dict[str, Any],
    user_emails_lower: List[str]
) -> Dict[str, Any]:
    """
    Original heuristic rules, used as a safe fallback if LLM classification fails.
    """
    summary = features['summary']
    description = features['description']
    attendee_count = features['attendee_count']
    user_is_attendee = features['user_is_attendee']
    is_organizer = features['is_organizer']
    attendees_raw = features.get('attendees', [])

    # Rule 1: Large public events (>20 attendees, user is only attendee)
    if attendee_count > 20 and not is_organizer and user_is_attendee:
        public_keywords = ['conference', 'summit', 'webinar', 'workshop', 'seminar', 'event', 'talk', 'presentation', 'meetup']
        if any(keyword in summary or keyword in description for keyword in public_keywords):
            return {
                'type': EVENT_TYPE_PUBLIC_EVENT,
                'confidence': 'high',
                'shouldPrep': False,
                'prepDepth': 'minimal',
                'reason': f'Large public event ({attendee_count} attendees), user is attendee only'
            }

    # Rule 2: Personal reminders (only user, no specific person mentioned)
    if attendee_count == 0 or (attendee_count == 1 and user_is_attendee):
        person_indicators = ['call', 'meeting', 'with', 'chat', 'sync', 'catch up']
        has_person_mention = any(indicator in summary for indicator in person_indicators)

        reminder_keywords = ['reminder', 'todo', 'task', 'gym', 'workout', 'exercise', 'meditation', 'break']
        is_reminder = any(keyword in summary for keyword in reminder_keywords)

        if is_reminder and not has_person_mention:
            return {
                'type': EVENT_TYPE_PERSONAL_REMINDER,
                'confidence': 'high',
                'shouldPrep': False,
                'prepDepth': 'none',
                'reason': 'Personal reminder with no specific person mentioned'
            }

        if has_person_mention:
            return {
                'type': EVENT_TYPE_MEETING,
                'confidence': 'medium',
                'shouldPrep': True,
                'prepDepth': 'full',
                'reason': 'Personal call/meeting with specific person mentioned'
            }

    # Rule 3: Family/leisure events
    leisure_keywords = ['movie', 'dinner', 'lunch', 'breakfast', 'family', 'friends', 'date', 'birthday', 'party', 'celebration']
    if any(keyword in summary or keyword in description for keyword in leisure_keywords):
        business_keywords = ['client', 'customer', 'partner', 'investor', 'board', 'team']
        is_business = any(keyword in summary or keyword in description for keyword in business_keywords)

        if not is_business:
            return {
                'type': EVENT_TYPE_LEISURE,
                'confidence': 'high',
                'shouldPrep': False,
                'prepDepth': 'minimal',
                'reason': 'Family/leisure event detected'
            }

    # Rule 4: Travel events
    travel_keywords = ['flight', 'airport', 'hotel', 'check-in', 'checkout', 'departure', 'arrival', 'travel', 'trip']
    if any(keyword in summary or keyword in description for keyword in travel_keywords):
        return {
            'type': EVENT_TYPE_TRAVEL,
            'confidence': 'high',
            'shouldPrep': False,
            'prepDepth': 'minimal',
            'reason': 'Travel event detected'
        }

    # Rule 5: Speaker/Panelist detection
    if is_organizer or (user_is_attendee and attendee_count > 5):
        speaker_keywords = ['speaker', 'panelist', 'host', 'moderator', 'presenter', 'keynote']
        user_role = None

        organizer = features.get('organizer') or {}
        if isinstance(organizer, dict):
            user_role = organizer.get('displayName') or organizer.get('email')

        if not user_role and attendees_raw:
            for att in attendees_raw:
                att_email = (att.get('email') or att.get('emailAddress') or '').lower() if isinstance(att, dict) else ''
                if any(u == att_email for u in user_emails_lower):
                    user_role = att.get('displayName') or att.get('responseStatus')
                    break

        role_text = (user_role or '').lower() if user_role else ''
        is_speaker = any(keyword in role_text or keyword in summary or keyword in description for keyword in speaker_keywords)

        if is_speaker or is_organizer:
            return {
                'type': EVENT_TYPE_MEETING,
                'confidence': 'high',
                'shouldPrep': True,
                'prepDepth': 'full',
                'reason': f'User is {"organizer" if is_organizer else "speaker/panelist"}, detailed prep needed'
            }

    # Rule 6: Default - treat as meeting if has multiple attendees
    if attendee_count >= 2:
        return {
            'type': EVENT_TYPE_MEETING,
            'confidence': 'medium',
            'shouldPrep': True,
            'prepDepth': 'full',
            'reason': f'Meeting with {attendee_count} attendees'
        }

    # Rule 7: Single attendee (1-on-1)
    if attendee_count == 1 and not user_is_attendee:
        return {
            'type': EVENT_TYPE_MEETING,
            'confidence': 'high',
            'shouldPrep': True,
            'prepDepth': 'full',
            'reason': '1-on-1 meeting'
        }

    return {
        'type': EVENT_TYPE_MEETING,
        'confidence': 'low',
        'shouldPrep': True,
        'prepDepth': 'full',
        'reason': 'Could not classify, defaulting to meeting'
    }


async def classify_calendar_event(
    event: Dict[str, Any],
    user_email: str,
    user_emails: Optional[List[str]] = None
) -> Dict[str, Any]:
    """
    LLM-first classification of a calendar event.

    - Uses the provided rules to decide meeting vs non-meeting.
    - Falls back to the previous rule-based heuristics if LLM parsing fails.
    """
    if not isinstance(event, dict):
        return {
            'type': EVENT_TYPE_UNKNOWN,
            'confidence': 'low',
            'shouldPrep': False,
            'prepDepth': 'none',
            'reason': 'Invalid event object'
        }

    user_emails_list = user_emails or [user_email]
    user_emails_lower = [e.lower() for e in user_emails_list if e]

    features = _extract_event_features(event, user_emails_lower)

    event_payload = {
        'title': features['summary_raw'] or '(untitled)',
        'description': features['description_raw'] or '',
        'attendeeCount': features['attendee_count'],
        'attendees': features['attendees'],
        'userEmails': user_emails_list,
        'userIsOrganizer': features['is_organizer'],
        'userIsAttendee': features['user_is_attendee'],
        'organizerEmail': features['organizer_email'],
        'start': event.get('start'),
        'end': event.get('end')
    }

    try:
        llm_response = await call_gpt([{
            'role': 'system',
            'content': """Classify calendar events to decide prep depth.
Return JSON only:
{"type":"meeting|public_event|personal_reminder|leisure|travel|unknown","confidence":"high|medium|low","shouldPrep":true|false,"prepDepth":"full|minimal|none","reason":"short explanation"}

Rules:
- Large public events: attendee_count > ~20 is usually public. If user is only attendee -> one-line mention (minimal, shouldPrep false). If user is speaker/panelist/host/organizer -> treat as meeting with full prep.
- Personal reminders: only user attending and no specific person in title/description -> general reminder (shouldPrep false, prepDepth none). If a specific person is named (e.g., "Call Anujay"), treat as meeting/call with full prep.
- Family/leisure: movie/dinner/family/friends/etc. -> one-line context (shouldPrep false, prepDepth minimal) unless clear business context.
- Travel: flights/airports/hotels/trips -> one-line mention (shouldPrep false, prepDepth minimal).
- Objective: reserve deep prep for meetings where context helps; avoid noise.
- When uncertain, be conservative: only mark shouldPrep true when it clearly benefits the user."""
        }, {
            'role': 'user',
            'content': f"Classify this event and return JSON only (no code fences):\n{json.dumps(event_payload, ensure_ascii=False)}"
        }], max_tokens=400)

        parsed = safe_parse_json(llm_response)
        normalized = _normalize_classification(parsed)
        if normalized:
            return normalized
    except Exception as error:
        logger.warn(f'LLM classification failed, falling back to rules: {str(error)}')

    return _rule_based_fallback(features, user_emails_lower)


def should_prep_event(classification: Dict[str, Any]) -> bool:
    """Helper to check if event should get full prep"""
    return classification.get('shouldPrep', False)


def get_prep_depth(classification: Dict[str, Any]) -> str:
    """Helper to get prep depth"""
    return classification.get('prepDepth', 'none')
