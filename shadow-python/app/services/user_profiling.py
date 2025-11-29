"""
User Profiling Service

Builds deep user profiles from communication patterns, expertise signals,
and behavioral patterns to personalize briefings
"""

import re
import json
from typing import Optional, Dict, Any, List
from datetime import datetime, timedelta
from app.services.gpt_service import call_gpt, safe_parse_json
from app.services.logger import logger
def _get_duration_in_weeks(events: List[Dict[str, Any]]) -> float:
    """
    Get duration in weeks from event date range
    """
    dates = []
    for event in events:
        if not isinstance(event, dict):
            continue
        start_obj = event.get('start')
        if isinstance(start_obj, dict):
            start_str = start_obj.get('dateTime') or start_obj.get('date')
        else:
            start_str = start_obj
            
        if start_str:
            try:
                date_obj = datetime.fromisoformat(str(start_str).replace('Z', '+00:00'))
                dates.append(date_obj)
            except Exception:
                pass
    
    if len(dates) < 2:
        return 1.0
    
    dates.sort()
    earliest = dates[0]
    latest = dates[-1]
    days = (latest - earliest).days
    return max(1.0, days / 7)


async def analyze_communication_style(user_emails: List[Dict[str, Any]], request_id: str = None) -> Dict[str, Any]:
    """
    Analyze user's communication style from email history
    
    Args:
        user_emails: Emails sent by the user
        request_id: Request ID for logging
    Returns:
        Communication style profile
    """
    if not user_emails or len(user_emails) < 5:
        return {
            'style': 'unknown',
            'formality': 'neutral',
            'verbosity': 'moderate',
            'confidence': 'low',
            'characteristics': []
        }
    
    # Sample up to 20 emails for analysis
    sample_emails = [
        {
            'subject': e.get('subject', ''),
            'bodyPreview': (e.get('body') or e.get('snippet') or '')[:1000],
            'to': e.get('to', ''),
            'hasAttachments': bool(e.get('attachments') and len(e.get('attachments', [])) > 0)
        }
        for e in user_emails[:20]
    ]
    
    try:
        analysis = await call_gpt([{
            'role': 'system',
            'content': """Analyze this user's communication style from their email patterns.

Return JSON:
{
  "style": "technical|executive|casual|formal|collaborative",
  "formality": "very_formal|formal|neutral|casual|very_casual",
  "verbosity": "concise|moderate|verbose",
  "tone": "direct|diplomatic|enthusiastic|analytical|authoritative",
  "characteristics": ["characteristic 1", "characteristic 2", ...]
}

Characteristics should include:
- Length preference (short bullets vs long explanations)
- Use of technical jargon
- Decision-making style (decisive vs collaborative)
- Question-asking frequency
- Use of data/metrics
- Emoji/punctuation patterns
- Signature phrases or patterns"""
        }, {
            'role': 'user',
            'content': f"User's emails:\n{json.dumps(sample_emails, default=str)}"
        }], 800)
        
        profile = safe_parse_json(analysis)
        if not isinstance(profile, dict):
            raise ValueError("Invalid profile format")
            
        return {
            **profile,
            'confidence': 'high' if len(user_emails) >= 20 else ('medium' if len(user_emails) >= 10 else 'low'),
            'sampleSize': len(user_emails)
        }
    except Exception as e:
        logger.warn(f'Communication style analysis failed: {str(e)}', requestId=request_id)
        return {
            'style': 'unknown',
            'formality': 'neutral',
            'verbosity': 'moderate',
            'confidence': 'low',
            'characteristics': []
        }


async def infer_expertise(user_emails: List[Dict[str, Any]], user_documents: List[Dict[str, Any]] = None, request_id: str = None) -> Dict[str, Any]:
    """
    Infer user's domain expertise from email vocabulary and topics
    
    Args:
        user_emails: Emails sent by the user
        user_documents: Documents created/modified by user
        request_id: Request ID for logging
    Returns:
        Expertise profile
    """
    if not user_documents:
        user_documents = []
        
    if (not user_emails or len(user_emails) < 3) and (not user_documents or len(user_documents) < 2):
        return {
            'domains': [],
            'level': 'unknown',
            'confidence': 'low'
        }
    
    # Extract vocabulary and topics from user content
    user_content = []
    
    if user_emails and len(user_emails) > 0:
        for e in user_emails[:30]:
            user_content.append({
                'type': 'email',
                'subject': e.get('subject', ''),
                'content': (e.get('body') or e.get('snippet') or '')[:2000]
            })
    
    if user_documents and len(user_documents) > 0:
        for d in user_documents[:10]:
            user_content.append({
                'type': 'document',
                'name': d.get('name', ''),
                'content': (d.get('content') or '')[:3000]
            })
    
    try:
        analysis = await call_gpt([{
            'role': 'system',
            'content': """Analyze this user's domain expertise based on their communication content.

Return JSON:
{
  "domains": ["domain 1", "domain 2", ...],
  "level": "beginner|intermediate|advanced|expert",
  "technicalDepth": "low|medium|high",
  "specializations": ["specialization 1", "specialization 2"],
  "evidenceSignals": ["What vocabulary/topics indicate expertise?"]
}

Look for:
- Technical terminology and depth
- Industry-specific jargon
- Problem-solving complexity
- Reference to advanced concepts
- Authoritative tone on topics
- Teaching/explaining behaviors"""
        }, {
            'role': 'user',
            'content': f"User content samples:\n{json.dumps(user_content, default=str)}"
        }], 1000)
        
        expertise = safe_parse_json(analysis)
        if not isinstance(expertise, dict):
            raise ValueError("Invalid expertise format")
            
        return {
            **expertise,
            'confidence': 'high' if len(user_content) >= 15 else ('medium' if len(user_content) >= 5 else 'low'),
            'sampleSize': len(user_content)
        }
    except Exception as e:
        logger.warn(f'Expertise inference failed: {str(e)}', requestId=request_id)
        return {
            'domains': [],
            'level': 'unknown',
            'confidence': 'low'
        }


def infer_company_from_email(email: str) -> Dict[str, Any]:
    """
    Extract company name from email domain
    
    Args:
        email: User's email address
    Returns:
        Company information
    """
    if not email or '@' not in email:
        return {'company': None, 'domain': None}
    
    domain = email.split('@')[1]
    if not domain:
        return {'company': None, 'domain': None}
    
    # Extract company name from domain (e.g., "kordn8.ai" -> "Kordn8")
    domain_parts = domain.split('.')
    company_part = domain_parts[0]
    
    # Capitalize first letter
    company = company_part[0].upper() + company_part[1:] if len(company_part) > 0 else None
    
    return {
        'company': company,
        'domain': domain,
        'source': 'email_domain'
    }


def extract_location_and_travel_patterns(calendar_events: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Extract location and travel patterns from calendar events
    
    Args:
        calendar_events: User's calendar events
    Returns:
        Location and travel data
    """
    if not calendar_events or len(calendar_events) == 0:
        return {
            'location': None,
            'travelPatterns': None
        }
    
    locations = []
    timezones = set()
    
    # Extract locations from events
    for event in calendar_events:
        if isinstance(event, dict) and event.get('location'):
            locations.append(event['location'])
        
        # Try to infer timezone from event times
        start_obj = event.get('start') if isinstance(event, dict) else None
        if isinstance(start_obj, dict) and start_obj.get('dateTime'):
            try:
                start_date = datetime.fromisoformat(start_obj['dateTime'].replace('Z', '+00:00'))
                # Compare UTC vs local time to infer timezone
                utc_offset = start_date.utcoffset()
                if utc_offset:
                    timezones.add(int(utc_offset.total_seconds() / 60))
            except Exception:
                pass
    
    # Extract cities from locations
    city_counts = {}
    for loc in locations:
        # Simple extraction: look for city patterns
        # Common patterns: "City, State", "City, Country", "City"
        city_match = re.search(r'([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)', str(loc))
        if city_match:
            city = city_match.group(1)
            city_counts[city] = city_counts.get(city, 0) + 1
    
    # Find primary location (most frequent city)
    sorted_cities = sorted(city_counts.items(), key=lambda x: x[1], reverse=True)
    primary_location = sorted_cities[0][0] if sorted_cities else None
    frequent_locations = [city for city, _ in sorted_cities[:5]]
    
    # Determine travel frequency
    unique_cities = len(city_counts)
    travel_frequency = 'rare'
    if unique_cities >= 5:
        travel_frequency = 'frequent'
    elif unique_cities >= 2:
        travel_frequency = 'occasional'
    
    # Infer timezone from most common UTC offset
    timezone_offsets = list(timezones)
    most_common_offset = None
    if timezone_offsets:
        most_common_offset = max(set(timezone_offsets), key=timezone_offsets.count)
    
    # Convert UTC offset to timezone (approximate)
    timezone = None
    if most_common_offset is not None:
        # Common timezone mappings (approximate)
        offset_minutes = most_common_offset
        if offset_minutes == -480:
            timezone = 'America/Los_Angeles'  # PST
        elif offset_minutes == -420:
            timezone = 'America/Denver'  # MST
        elif offset_minutes == -300:
            timezone = 'America/New_York'  # EST
        elif offset_minutes == 0:
            timezone = 'Europe/London'  # GMT
        elif offset_minutes == 330:
            timezone = 'Asia/Kolkata'  # IST
    
    return {
        'location': {
            'city': primary_location,
            'timezone': timezone
        } if primary_location else None,
        'travelPatterns': {
            'primaryLocation': primary_location or None,
            'frequentLocations': frequent_locations,
            'travelFrequency': travel_frequency,
            'uniqueCities': unique_cities
        }
    }


async def extract_biographical_info(user_sent_emails: List[Dict[str, Any]] = None, user_received_emails: List[Dict[str, Any]] = None, request_id: str = None) -> Dict[str, Any]:
    """
    Extract biographical information from email signatures and content
    Uses both sent and received emails for comprehensive context
    
    Args:
        user_sent_emails: Emails sent by the user
        user_received_emails: Emails received by the user
        request_id: Request ID for logging
    Returns:
        Biographical data
    """
    if not user_sent_emails:
        user_sent_emails = []
    if not user_received_emails:
        user_received_emails = []
    
    # Combine both email sets, prioritizing sent emails
    all_emails_for_analysis = [
        *[{'source': 'sent', **e} for e in user_sent_emails[:15]],
        *[{'source': 'received', **e} for e in user_received_emails[:10]]
    ]
    
    if len(all_emails_for_analysis) == 0:
        return {
            'jobTitle': None,
            'company': None,
            'location': None,
            'phone': None
        }
    
    # Extract email signatures and relevant content
    email_samples = []
    for e in all_emails_for_analysis:
        body = (e.get('body') or e.get('snippet') or '').strip()
        # Extract last 15 lines (likely signature area)
        lines = body.split('\n')
        signature_lines = '\n'.join(lines[-15:])
        
        email_samples.append({
            'source': e.get('source', ''),
            'subject': e.get('subject', ''),
            'from': e.get('from', ''),
            'to': e.get('to', ''),
            'body': body[:2000],  # Full body for context
            'signature': signature_lines,  # Last 15 lines (signature area)
            'date': e.get('date', '')
        })
    
    try:
        analysis = await call_gpt([{
            'role': 'system',
            'content': """Extract biographical information from email signatures and content. Analyze BOTH sent emails (user's own signatures) and received emails (how others address the user).

Return JSON:
{
  "jobTitle": "CEO" | "Founder" | "Senior Engineer" | null,
  "company": "Company Name" | null,
  "location": {
    "city": "City Name" | null,
    "state": "State/Province" | null,
    "country": "Country" | null
  },
  "phone": "+1-xxx-xxx-xxxx" | null,
  "confidence": "high" | "medium" | "low"
}

Look for:
- Job titles in signatures (e.g., "CEO", "Founder", "Senior Engineer")
- Company names in signatures or email domains
- Location information (city, state, country)
- Phone numbers in signatures
- How others address the user in received emails (may indicate role/company)

Prioritize information from sent emails (user's own signatures) but also use received emails for context."""
        }, {
            'role': 'user',
            'content': f"Email samples (sent={len(user_sent_emails)}, received={len(user_received_emails)}):\n{json.dumps(email_samples, default=str)}"
        }], 1200)
        
        biographical_data = safe_parse_json(analysis)
        if not isinstance(biographical_data, dict):
            raise ValueError("Invalid biographical data format")
            
        return {
            'jobTitle': biographical_data.get('jobTitle'),
            'company': biographical_data.get('company'),
            'location': biographical_data.get('location'),
            'phone': biographical_data.get('phone'),
            'confidence': biographical_data.get('confidence', 'low')
        }
    except Exception as e:
        logger.warn(f'Biographical info extraction failed: {str(e)}', requestId=request_id)
        return {
            'jobTitle': None,
            'company': None,
            'location': None,
            'phone': None,
            'confidence': 'low'
        }


async def extract_role_from_email_content(user_sent_emails: List[Dict[str, Any]] = None, user_received_emails: List[Dict[str, Any]] = None, request_id: str = None) -> Dict[str, Any]:
    """
    Extract role and company information from email content
    Analyzes both sent and received emails for comprehensive context
    
    Args:
        user_sent_emails: Emails sent by the user
        user_received_emails: Emails received by the user
        request_id: Request ID for logging
    Returns:
        Role and company information
    """
    if not user_sent_emails:
        user_sent_emails = []
    if not user_received_emails:
        user_received_emails = []
    
    # Combine both email sets
    all_emails_for_analysis = [
        *[{'source': 'sent', **e} for e in user_sent_emails[:20]],
        *[{'source': 'received', **e} for e in user_received_emails[:15]]
    ]
    
    if len(all_emails_for_analysis) == 0:
        return {
            'jobTitle': None,
            'company': None,
            'confidence': 'low'
        }
    
    # Extract relevant content from emails
    email_content = []
    for e in all_emails_for_analysis:
        body = (e.get('body') or e.get('snippet') or '').strip()
        email_content.append({
            'source': e.get('source', ''),
            'subject': e.get('subject', ''),
            'from': e.get('from', ''),
            'to': e.get('to', ''),
            'content': body[:1500],  # First 1500 chars (intro + signature area)
            'date': e.get('date', '')
        })
    
    try:
        analysis = await call_gpt([{
            'role': 'system',
            'content': """Extract job title and company information from email content. Analyze BOTH sent emails (user's self-descriptions) and received emails (how others address/refer to the user).

Return JSON:
{
  "jobTitle": "CEO" | "Founder" | "Senior Engineer" | null,
  "company": "Company Name" | null,
  "confidence": "high" | "medium" | "low",
  "evidence": ["evidence 1", "evidence 2"]
}

Look for:
- From sent emails: Direct self-descriptions ("I'm the CEO", "as a Senior Engineer", "at Kordn8")
- From received emails: How others address the user ("Hi Anujay, CEO of...", "thanks for leading...")
- Role descriptions in email signatures or introductions
- Company mentions in both directions

Prioritize sent emails but use received emails for additional context."""
        }, {
            'role': 'user',
            'content': f"Email content (sent={len(user_sent_emails)}, received={len(user_received_emails)}):\n{json.dumps(email_content, default=str)}"
        }], 1200)
        
        role_data = safe_parse_json(analysis)
        if not isinstance(role_data, dict):
            raise ValueError("Invalid role data format")
            
        return {
            'jobTitle': role_data.get('jobTitle'),
            'company': role_data.get('company'),
            'confidence': role_data.get('confidence', 'low'),
            'evidence': role_data.get('evidence', [])
        }
    except Exception as e:
        logger.warn(f'Role extraction failed: {str(e)}', requestId=request_id)
        return {
            'jobTitle': None,
            'company': None,
            'confidence': 'low',
            'evidence': []
        }


def analyze_working_patterns(events: List[Dict[str, Any]], user_email: str) -> Dict[str, Any]:
    """
    Analyze working patterns from calendar events
    
    Args:
        events: Calendar events
        user_email: User's email
    Returns:
        Working pattern analysis
    """
    if not events or len(events) == 0:
        return {
            'meetingsPerWeek': 0,
            'oneOnOneRatio': 0,
            'organizerRatio': 0,
            'totalMeetings': 0,
            'preferredMeetingSize': 'unknown'
        }
    
    # Calculate duration in weeks
    dates = []
    for event in events:
        if not isinstance(event, dict):
            continue
        start_obj = event.get('start')
        if isinstance(start_obj, dict):
            start_str = start_obj.get('dateTime') or start_obj.get('date')
        else:
            start_str = start_obj
            
        if start_str:
            try:
                date_obj = datetime.fromisoformat(str(start_str).replace('Z', '+00:00'))
                dates.append(date_obj)
            except Exception:
                pass
    
    duration_weeks = _get_duration_in_weeks(events)
    
    # Meeting frequency
    meetings_per_week = len(events) / duration_weeks if duration_weeks > 0 else 0
    
    # Meeting types (1:1 vs group)
    one_on_ones = sum(1 for e in events if isinstance(e, dict) and len(e.get('attendees', [])) <= 2)
    group_meetings = len(events) - one_on_ones
    
    # Response patterns (organizer vs attendee)
    user_email_lower = user_email.lower()
    organized = 0
    for e in events:
        if not isinstance(e, dict):
            continue
        organizer = e.get('organizer', '')
        # Handle both string (email) and dict formats
        if isinstance(organizer, str):
            organizer_email = organizer
        elif isinstance(organizer, dict):
            organizer_email = organizer.get('email', '')
        else:
            organizer_email = ''
        if user_email_lower in organizer_email.lower():
            organized += 1
    
    return {
        'meetingsPerWeek': round(meetings_per_week),
        'oneOnOneRatio': one_on_ones / len(events) if events else 0,
        'organizerRatio': organized / len(events) if events else 0,
        'totalMeetings': len(events),
        'preferredMeetingSize': 'small' if one_on_ones > group_meetings else 'large'
    }


async def build_user_profile(user: Dict[str, Any], all_emails: List[Dict[str, Any]] = None, all_documents: List[Dict[str, Any]] = None, calendar_events: List[Dict[str, Any]] = None, request_id: str = None) -> Dict[str, Any]:
    """
    Build comprehensive user profile from available data
    
    Args:
        user: User object with basic info
        all_emails: All emails (user's and others')
        all_documents: All documents
        calendar_events: User's calendar events
        request_id: Request ID for logging
    Returns:
        Comprehensive user profile
    """
    if not all_emails:
        all_emails = []
    if not all_documents:
        all_documents = []
    if not calendar_events:
        calendar_events = []
    
    profile = {
        'userId': user.get('id'),
        'email': user.get('email'),
        'name': user.get('name'),
        'communicationStyle': None,
        'expertise': None,
        'workingPatterns': None,
        'biographicalInfo': None,
        'relationships': []
    }
    
    user_email_lower = user.get('email', '').lower()
    
    # Extract user's sent emails (FROM user)
    user_sent_emails = [
        e for e in all_emails
        if isinstance(e, dict) and user_email_lower in (e.get('from', '') or '').lower()
    ]
    
    # Extract user's received emails (TO user or user in recipients)
    user_received_emails = [
        e for e in all_emails
        if isinstance(e, dict) and (
            user_email_lower in (e.get('to', '') or '').lower() or
            user_email_lower in (e.get('cc', '') or '').lower() or
            user_email_lower in (e.get('bcc', '') or '').lower()
        )
    ]
    
    # Extract user's documents
    user_documents = [
        d for d in all_documents
        if isinstance(d, dict) and user_email_lower in (d.get('ownerEmail') or d.get('owner') or '').lower()
    ]
    
    # Analyze communication style if enough data
    if len(user_sent_emails) >= 5:
        logger.info(f"  👤 Analyzing {user.get('name')}'s communication style from {len(user_sent_emails)} emails...", requestId=request_id)
        profile['communicationStyle'] = await analyze_communication_style(user_sent_emails, request_id)
    
    # Infer expertise if enough data
    if len(user_sent_emails) >= 3 or len(user_documents) >= 2:
        logger.info(f"  🎓 Inferring {user.get('name')}'s domain expertise...", requestId=request_id)
        profile['expertise'] = await infer_expertise(user_sent_emails, user_documents, request_id)
    
    # Analyze working patterns from calendar
    if calendar_events and len(calendar_events) >= 10:
        profile['workingPatterns'] = analyze_working_patterns(calendar_events, user.get('email', ''))
    
    # Extract biographical information
    logger.info(f"  📋 Extracting biographical info (sent: {len(user_sent_emails)}, received: {len(user_received_emails)})...", requestId=request_id)
    
    # Extract from email signatures and content
    biographical_from_emails = await extract_biographical_info(user_sent_emails, user_received_emails, request_id)
    
    # Extract role/company from email content
    role_from_content = await extract_role_from_email_content(user_sent_emails, user_received_emails, request_id)
    
    # Extract company from email domain
    company_from_domain = infer_company_from_email(user.get('email', ''))
    
    # Extract location/travel from calendar
    location_and_travel = extract_location_and_travel_patterns(calendar_events)
    
    # Merge location data (combine email and calendar sources)
    merged_location = None
    if biographical_from_emails.get('location') or location_and_travel.get('location'):
        merged_location = {
            'city': (biographical_from_emails.get('location') or {}).get('city') or (location_and_travel.get('location') or {}).get('city'),
            'state': (biographical_from_emails.get('location') or {}).get('state'),
            'country': (biographical_from_emails.get('location') or {}).get('country'),
            'timezone': (biographical_from_emails.get('location') or {}).get('timezone') or (location_and_travel.get('location') or {}).get('timezone')
        }
        # Remove None values
        merged_location = {k: v for k, v in merged_location.items() if v is not None}
        if not merged_location:
            merged_location = None
    
    # Merge biographical information (prioritize email signatures, then content, then domain)
    profile['biographicalInfo'] = {
        'jobTitle': biographical_from_emails.get('jobTitle') or role_from_content.get('jobTitle'),
        'company': biographical_from_emails.get('company') or role_from_content.get('company') or company_from_domain.get('company'),
        'location': merged_location,
        'phone': biographical_from_emails.get('phone'),
        'travelPatterns': location_and_travel.get('travelPatterns'),
        'confidence': biographical_from_emails.get('confidence') or role_from_content.get('confidence', 'low'),
        'sources': {
            'emailDomain': 'email_domain' if company_from_domain.get('company') else None,
            'emailSignatures': 'email_signatures' if (biographical_from_emails.get('jobTitle') or biographical_from_emails.get('company')) else None,
            'emailContent': 'email_content' if (role_from_content.get('jobTitle') or role_from_content.get('company')) else None,
            'calendar': 'calendar' if location_and_travel.get('location') else None
        }
    }
    
    return profile

