"""
Calendar Event Classifier

Distinguishes actual meetings from calendar noise (travel, reminders, public events, etc.)
"""

from typing import Dict, Any, Optional, List
from app.services.logger import logger


# Event types
EVENT_TYPE_MEETING = 'meeting'
EVENT_TYPE_PUBLIC_EVENT = 'public_event'
EVENT_TYPE_PERSONAL_REMINDER = 'personal_reminder'
EVENT_TYPE_LEISURE = 'leisure'
EVENT_TYPE_TRAVEL = 'travel'
EVENT_TYPE_UNKNOWN = 'unknown'


def classify_calendar_event(
    event: Dict[str, Any],
    user_email: str,
    user_emails: Optional[List[str]] = None
) -> Dict[str, Any]:
    """
    Classify a calendar event to determine if it's a real meeting
    
    Args:
        event: Calendar event object
        user_email: User's primary email
        user_emails: Optional list of all user emails (for multi-account)
    
    Returns:
        Dict with:
        - type: 'meeting', 'public_event', 'personal_reminder', 'leisure', 'travel', 'unknown'
        - confidence: 'high', 'medium', 'low'
        - shouldPrep: bool (whether to do full prep)
        - prepDepth: 'full', 'minimal', 'none'
        - reason: str (explanation)
    """
    if not isinstance(event, dict):
        return {
            'type': EVENT_TYPE_UNKNOWN,
            'confidence': 'low',
            'shouldPrep': False,
            'prepDepth': 'none',
            'reason': 'Invalid event object'
        }
    
    # Get user emails list
    user_emails_list = user_emails or [user_email]
    user_emails_lower = [e.lower() for e in user_emails_list if e]
    
    # Extract event details
    summary = (event.get('summary') or event.get('title') or '').lower()
    description = (event.get('description') or '').lower()
    attendees = event.get('attendees', [])
    organizer = event.get('organizer', {})
    
    # Check if user is organizer
    is_organizer = False
    organizer_email = ''
    if isinstance(organizer, dict):
        organizer_email = (organizer.get('email') or '').lower()
    elif isinstance(organizer, str):
        organizer_email = organizer.lower()
    
    is_organizer = any(user_email_lower == organizer_email for user_email_lower in user_emails_lower)
    
    # Count attendees (excluding user)
    attendee_count = 0
    user_is_attendee = False
    if isinstance(attendees, list):
        for att in attendees:
            if not isinstance(att, dict):
                continue
            att_email = (att.get('email') or att.get('emailAddress') or '').lower()
            if att_email:
                attendee_count += 1
                if any(user_email_lower == att_email for user_email_lower in user_emails_lower):
                    user_is_attendee = True
    
    # Rule 1: Large public events (>20 attendees, user is only attendee)
    if attendee_count > 20 and not is_organizer and user_is_attendee:
        # Check for public event indicators
        public_keywords = ['conference', 'summit', 'webinar', 'workshop', 'seminar', 'event', 'talk', 'presentation', 'meetup']
        if any(keyword in summary or keyword in description for keyword in public_keywords):
            return {
                'type': EVENT_TYPE_PUBLIC_EVENT,
                'confidence': 'high',
                'shouldPrep': False,
                'prepDepth': 'minimal',  # One-line mention only
                'reason': f'Large public event ({attendee_count} attendees), user is attendee only'
            }
    
    # Rule 2: Personal reminders (only user, no specific person mentioned)
    if attendee_count == 0 or (attendee_count == 1 and user_is_attendee):
        # Check if it mentions a specific person
        person_indicators = ['call', 'meeting', 'with', 'chat', 'sync', 'catch up']
        has_person_mention = any(indicator in summary for indicator in person_indicators)
        
        # Check for reminder keywords
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
        
        # If specific person is mentioned (e.g., "Call Anujay"), treat as meeting
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
        # Check if it's actually a business meeting disguised as leisure
        business_keywords = ['client', 'customer', 'partner', 'investor', 'board', 'team']
        is_business = any(keyword in summary or keyword in description for keyword in business_keywords)
        
        if not is_business:
            return {
                'type': EVENT_TYPE_LEISURE,
                'confidence': 'high',
                'shouldPrep': False,
                'prepDepth': 'minimal',  # One-line context only
                'reason': 'Family/leisure event detected'
            }
    
    # Rule 4: Travel events
    travel_keywords = ['flight', 'airport', 'hotel', 'check-in', 'checkout', 'departure', 'arrival', 'travel', 'trip']
    if any(keyword in summary or keyword in description for keyword in travel_keywords):
        return {
            'type': EVENT_TYPE_TRAVEL,
            'confidence': 'high',
            'shouldPrep': False,
            'prepDepth': 'minimal',  # One-line mention only
            'reason': 'Travel event detected'
        }
    
    # Rule 5: Speaker/Panelist detection
    if is_organizer or (user_is_attendee and attendee_count > 5):
        # Check for speaker/panelist indicators
        speaker_keywords = ['speaker', 'panelist', 'host', 'moderator', 'presenter', 'keynote']
        user_role = None
        
        # Check organizer field
        if isinstance(organizer, dict):
            user_role = organizer.get('displayName') or organizer.get('email')
        
        # Check attendees for role
        if not user_role and isinstance(attendees, list):
            for att in attendees:
                if not isinstance(att, dict):
                    continue
                att_email = (att.get('email') or att.get('emailAddress') or '').lower()
                if any(user_email_lower == att_email for user_email_lower in user_emails_lower):
                    user_role = att.get('displayName') or att.get('responseStatus')
                    break
        
        # Check if user is speaker/panelist
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
    
    # Default: unknown, but treat as meeting to be safe
    return {
        'type': EVENT_TYPE_MEETING,
        'confidence': 'low',
        'shouldPrep': True,
        'prepDepth': 'full',
        'reason': 'Could not classify, defaulting to meeting'
    }


def should_prep_event(classification: Dict[str, Any]) -> bool:
    """Helper to check if event should get full prep"""
    return classification.get('shouldPrep', False)


def get_prep_depth(classification: Dict[str, Any]) -> str:
    """Helper to get prep depth"""
    return classification.get('prepDepth', 'none')

