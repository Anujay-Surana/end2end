"""
Email Relevance Service

Filters emails for meeting relevance and extracts context
Uses GPT for relevance filtering and context extraction
"""

import re
import json
import asyncio
from datetime import datetime
from typing import List, Dict, Any, Optional, Tuple
from app.services.gpt_service import call_gpt, safe_parse_json
from app.services.temporal_scoring import score_and_rank_emails
from app.services.google_api import parse_email_date
from app.services.logger import logger


def _is_similar(str1: Optional[str], str2: Optional[str]) -> bool:
    """Check if two strings are similar (simple similarity check)"""
    if not str1 or not str2:
        return False
    s1 = str1.lower()[:100]
    s2 = str2.lower()[:100]
    # Check if one contains the other (80% overlap)
    return (
        s1 in s2[:int(len(s2) * 0.8)] or
        s2 in s1[:int(len(s1) * 0.8)]
    )


def _deduplicate_array(arr: List[str]) -> List[str]:
    """Deduplicate array using similarity check"""
    seen = []
    result = []
    for item in arr:
        if not item or not isinstance(item, str):
            continue
        is_dup = any(_is_similar(item, seen_item) for seen_item in seen)
        if not is_dup:
            seen.append(item)
            result.append(item)
    return result


def _calculate_days_ago(date_str: Optional[str]) -> int:
    """Calculate days ago from date string"""
    if not date_str:
        return 999999  # Very old
    try:
        date = parse_email_date(date_str)
        if not date:
            return 999999
        now = datetime.now(date.tzinfo) if date.tzinfo else datetime.utcnow()
        days = (now - date.replace(tzinfo=None) if date.tzinfo else now - date).days
        return max(0, days)
    except Exception:
        return 999999


def _count_attendees_in_email(email: Dict[str, Any], attendees: List[Dict[str, Any]]) -> int:
    """Count how many meeting attendees are in this email"""
    from_email = (email.get('from') or '').lower()
    to_emails = [(e.strip().lower()) for e in (email.get('to') or '').split(',') if e.strip()]
    cc_emails = [(e.strip().lower()) for e in (email.get('cc') or '').split(',') if e.strip()]
    all_emails_in_message = [from_email] + to_emails + cc_emails
    
    attendee_emails = [
        (a.get('email') or a.get('emailAddress') or '').lower()
        for a in attendees
        if a.get('email') or a.get('emailAddress')
    ]
    
    return sum(1 for email_addr in all_emails_in_message if any(att_email in email_addr for att_email in attendee_emails))


def filter_emails_by_attendee_overlap(
    emails: List[Dict[str, Any]],
    attendees: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Filter emails by attendee overlap using strict criteria
    
    Rules:
    - <=4 attendees: require 100% overlap (ALL attendees must match)
    - >=5 attendees: require 75% overlap (at least 75% must match)
    - This ensures the meeting is a subset of or same as the email participants
    
    Args:
        emails: List of email objects
        attendees: List of attendee objects
    
    Returns:
        Filtered list of emails that meet overlap criteria
    """
    if not emails or not attendees:
        return emails
    
    # Extract attendee emails
    attendee_emails = []
    for att in attendees:
        if isinstance(att, dict):
            email = att.get('email') or att.get('emailAddress')
            if email:
                attendee_emails.append(email.lower())
    
    if not attendee_emails:
        return emails
    
    attendee_count = len(attendee_emails)
    
    # Calculate overlap threshold
    if attendee_count <= 4:
        overlap_threshold = 1.0  # 100% - all attendees must match
    else:
        overlap_threshold = 0.75  # 75% - at least 75% must match
    
    filtered_emails = []
    for email in emails:
        if not isinstance(email, dict):
            continue
        
        # Extract email participants
        from_email = (email.get('from') or '').lower()
        to_emails = [e.strip().lower() for e in (email.get('to') or '').split(',') if e.strip()]
        cc_emails = [e.strip().lower() for e in (email.get('cc') or '').split(',') if e.strip()]
        email_participants = set([from_email] + to_emails + cc_emails)
        
        # Calculate overlap
        matching = [e for e in attendee_emails if e in email_participants]
        overlap_count = len(matching)
        
        # Check if meets threshold (strict criteria only)
        overlap_ratio = overlap_count / attendee_count if attendee_count > 0 else 0
        meets_threshold = overlap_ratio >= overlap_threshold
        
        if meets_threshold:
            email['_attendeeOverlap'] = {
                'matching': overlap_count,
                'total': attendee_count,
                'ratio': overlap_ratio,
                'matchedEmails': matching
            }
            filtered_emails.append(email)
    
    return filtered_emails


async def _filter_email_batch(
    batch: Dict[str, Any],
    batch_index: int,
    total_batches: int,
    meeting_title: str,
    meeting_date_context: str,
    meeting_context: Optional[Dict[str, Any]],
    user_context: Optional[Dict[str, Any]],
    attendees: List[Dict[str, Any]],
    purpose_result: Optional[Dict[str, Any]] = None,
    request_id: str = 'unknown'
) -> Dict[str, Any]:
    """Filter a batch of emails for relevance"""
    logger.info(
        f'     Relevance check batch {batch_index + 1}/{total_batches} ({len(batch["emails"])} emails)...',
        requestId=request_id
    )

    user_context_prefix = ''
    if user_context:
        user_context_prefix = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). '

    # Extract company name from user context for noise filtering
    user_company = None
    if user_context:
        email_domain = user_context.get('email', '').split('@')[1] if '@' in user_context.get('email', '') else None
        if email_domain and 'gmail.com' not in email_domain and 'yahoo.com' not in email_domain and 'outlook.com' not in email_domain:
            domain_parts = email_domain.split('.')
            company_part = domain_parts[0] if domain_parts else None
            if company_part:
                user_company = company_part.capitalize()

    company_filter_note = ''
    if user_company:
        company_filter_note = f'\n\nUSER CONTEXT - COMPANY NAME FILTERING:\n- User\'s Company: "{user_company}"\n- IMPORTANT: Company name appears frequently in emails - don\'t use it alone as a relevance signal\n- If email only mentions company name ({user_company}) without other meeting context (entities, topics, attendees), it\'s likely noise - exclude unless there\'s clear connection to meeting purpose/entities'

    # Build meeting context section
    meeting_context_section = ''
    if meeting_context:
        key_entities = meeting_context.get('keyEntities', [])
        key_topics = meeting_context.get('keyTopics', [])
        meeting_context_section = f'''
MEETING CONTEXT:
- Understood Purpose: {meeting_context.get("understoodPurpose", "")}
- Key Entities: {", ".join(key_entities) if key_entities else "none identified"}
- Key Topics: {", ".join(key_topics) if key_topics else "none identified"}
- Is Specific Meeting: {"yes" if meeting_context.get("isSpecificMeeting") else "no"}
- Confidence: {meeting_context.get("confidence", "unknown")}
- Reasoning: {meeting_context.get("reasoning", "")}'''
    
    # Add purpose result section if available
    purpose_section = ''
    if purpose_result:
        purpose = purpose_result.get('purpose')
        agenda = purpose_result.get('agenda', [])
        confidence = purpose_result.get('confidence', 'low')
        source = purpose_result.get('source', 'unknown')
        purpose_section = f'''

DETECTED MEETING PURPOSE (HIGH PRIORITY - USE THIS TO GUIDE FILTERING):
- Purpose: {purpose if purpose else "Not detected"}
- Agenda Items: {", ".join(agenda[:5]) if agenda else "None"}
- Confidence: {confidence}
- Source: {source}
- IMPORTANT: Prioritize emails that relate to this specific purpose and agenda items'''

    # Determine filtering strictness based on confidence
    confidence = meeting_context.get('confidence', 'low') if meeting_context else 'low'
    key_entities_str = ', '.join(meeting_context.get('keyEntities', [])) if meeting_context else 'none'
    
    if confidence == 'low':
        filtering_strictness = f'''
FILTERING STRICTNESS (LOW CONFIDENCE - BE VERY SELECTIVE):
- Only include emails with STRONG evidence of relevance to extracted entities/topics
- Require clear, specific connection to meeting entities ({key_entities_str})
- Don't default to general company context
- Err on the side of EXCLUSION when uncertain
- Target: 30-50% inclusion rate (be conservative)'''
    elif confidence == 'medium':
        filtering_strictness = '''
FILTERING STRICTNESS (MEDIUM CONFIDENCE):
- Include emails with clear connection to meeting
- Prioritize emails involving extracted entities/topics
- Target: 50-70% inclusion rate'''
    else:
        filtering_strictness = '''
FILTERING STRICTNESS (HIGH CONFIDENCE):
- Include emails that relate to understood purpose/entities
- Can be more comprehensive
- Target: 60-80% inclusion rate'''

    # Build email list for GPT
    email_list = []
    for i, e in enumerate(batch['emails']):
        body_preview = (e.get('body') or e.get('snippet') or '')[:2000]
        snippet = (e.get('snippet') or '')[:200]
        days_ago = _calculate_days_ago(e.get('date'))
        attendee_count = _count_attendees_in_email(e, attendees)
        
        email_list.append(
            f'[{i}] Subject: {e.get("subject", "")}\n'
            f'From: {e.get("from", "")}\n'
            f'To: {e.get("to", "N/A")}\n'
            f'Date: {e.get("date", "")} ({days_ago} days ago)\n'
            f'Attendee Count: {attendee_count} meeting attendees\n'
            f'Snippet: {snippet}\n'
            f'Body Preview: {body_preview}{"...[truncated]" if len(body_preview) >= 2000 else ""}'
        )

    important_msg_email = ''
    if user_context:
        important_msg_email = f'IMPORTANT: {user_context["formattedName"]} is the user you are preparing this brief for. Filter emails that are relevant to {user_context["formattedName"]}\'s understanding of this meeting.\n\n'
    
    # Build include criteria with purpose guidance
    include_criteria = f'✅ INCLUDE IF:\n'
    include_criteria += f'1. Email involves meeting attendees AND relates to understood purpose/entities/topics\n'
    if purpose_result and purpose_result.get('purpose'):
        include_criteria += f'2. Email relates to detected meeting purpose: "{purpose_result.get("purpose")}"\n'
        if purpose_result.get('agenda'):
            include_criteria += f'3. Email discusses agenda items: {", ".join(purpose_result.get("agenda", [])[:3])}\n'
        include_criteria += f'4. Email provides context about the detected meeting purpose\n'
    include_criteria += f'5. Email discusses meeting-specific entities/topics (not just company name)\n'
    include_criteria += f'6. Email involves extracted key entities ({key_entities_str})\n'
    
    exclude_criteria = f'❌ EXCLUDE IF:\n'
    exclude_criteria += f'1. Email only mentions company name without meeting context/entities/topics\n'
    if purpose_result and purpose_result.get('purpose'):
        exclude_criteria += f'2. Email is about different purpose than detected meeting purpose\n'
    exclude_criteria += f'3. Email is about different entities/topics than meeting\n'
    exclude_criteria += f'4. Email is general company operations unrelated to understood purpose\n'
    exclude_criteria += f'5. Email doesn\'t involve meeting attendees or extracted entities\n'
    
    relevance_check = await call_gpt([{
        'role': 'system',
        'content': (
            f'{user_context_prefix}You are filtering emails for meeting prep. Meeting: "{meeting_title}"{meeting_date_context}{meeting_context_section}{purpose_section}{company_filter_note}\n\n'
            + important_msg_email
            + include_criteria + '\n\n'
            + exclude_criteria + '\n\n'
            + f'DATE PRIORITIZATION: Prioritize emails from the last 30 days, but include older emails if highly relevant.\n\n'
            + f'ATTENDEE PRIORITIZATION: Prioritize emails with multiple meeting attendees (higher attendee count = more relevant).\n\n'
            + f'{filtering_strictness}\n\n'
            + f'Return JSON with email indices to INCLUDE (relative to this batch) AND reasoning:\n'
            + f'{{"relevant_indices": [0, 3, 7, ...], "reasoning": {{"0": "why email 0 is relevant", "3": "why email 3 is relevant", ...}}}}'
        )
    }, {
        'role': 'user',
        'content': f'Emails to filter:\n\n' + '\n\n'.join(email_list)
    }], 4000)

    batch_indices = []
    batch_reasoning = {}
    
    try:
        parsed = safe_parse_json(relevance_check)
        batch_indices = [batch['start'] + idx for idx in (parsed.get('relevant_indices') or [])]
        
        # Store reasoning for each relevant email
        if parsed.get('reasoning'):
            for relative_idx_str, reasoning in parsed['reasoning'].items():
                try:
                    relative_idx = int(relative_idx_str)
                    absolute_idx = batch['start'] + relative_idx
                    batch_reasoning[absolute_idx] = reasoning
                except (ValueError, KeyError):
                    continue
    except Exception as e:
        logger.error(
            f'Failed to parse email relevance check - excluding batch from analysis',
            requestId=request_id,
            error=str(e),
            batchStart=batch['start'],
            batchSize=len(batch['emails']),
            meetingTitle=meeting_title
        )
        logger.info(f'  ⚠️  Failed to parse relevance check for batch {batch_index + 1}, excluding from analysis', requestId=request_id)
        batch_indices = []

    
    return {'indices': batch_indices, 'reasoning': batch_reasoning}


async def _extract_context_batch(
    batch: Dict[str, Any],
    batch_index: int,
    total_batches: int,
    meeting_title: str,
    meeting_date_context: str,
    user_context: Optional[Dict[str, Any]],
    request_id: str
) -> Optional[Dict[str, Any]]:
    """Extract context from a batch of relevant emails"""
    logger.info(
        f'     Context extraction batch {batch_index + 1}/{total_batches} ({len(batch["emails"])} emails)...',
        requestId=request_id
    )

    user_context_prefix = ''
    if user_context:
        user_context_prefix = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). '

    # Build email content for GPT
    email_content_list = []
    for e in batch['emails']:
        body = e.get('body') or e.get('snippet') or ''
        # Use first 6000 + last 2000 chars for better context preservation
        if len(body) > 8000:
            body_preview = body[:6000] + '\n\n[...middle content truncated...]\n\n' + body[-2000:]
        else:
            body_preview = body

        thread_info = ''
        if e.get('_threadInfo'):
            thread = e['_threadInfo']
            earliest = thread.get('dateRange', {}).get('earliest')
            latest = thread.get('dateRange', {}).get('latest')
            earliest_str = earliest.strftime('%Y-%m-%d') if earliest else ''
            latest_str = latest.strftime('%Y-%m-%d') if latest else ''
            thread_info = f'\nThread Info: {thread.get("messageCount", 0)} messages, {len(thread.get("participants", []))} participants'
            if earliest_str:
                thread_info += f', from {earliest_str}'
            if latest_str:
                thread_info += f' to {latest_str}'

        attachment_info = ''
        if e.get('attachments'):
            attachment_info = '\nAttachments: ' + ', '.join([
                f'{a.get("filename", "")} ({a.get("mimeType", "")}, {a.get("size", 0)} bytes)'
                for a in e['attachments']
            ])

        email_content_list.append(
            f'Subject: {e.get("subject", "")}\n'
            f'From: {e.get("from", "")}\n'
            f'Date: {e.get("date", "")}{thread_info}{attachment_info}\n'
            f'Body: {body_preview}'
        )

    # Build the important message
    important_msg = ''
    if user_context:
        important_msg = f'IMPORTANT: {user_context["formattedName"]} is the user you are preparing this brief for. Structure all analysis from {user_context["formattedName"]}\'s perspective. When referring to {user_context["formattedName"]}, use "you" or "{user_context["formattedName"]}".'

    # Build perspective strings
    perspective_str = "The user's" if not user_context else user_context["formattedName"] + "'s"
    user_ref = "the user's" if not user_context else user_context["formattedName"] + "'s"
    
    # Build action items question
    action_items_q = "Who needs to do what?"
    if user_context:
        action_items_q = f'What does {user_context["formattedName"]} need to do? What do others need to do?'

    topics_extraction = await call_gpt([{
        'role': 'system',
        'content': (
            f'{user_context_prefix}Deeply analyze these emails to extract ALL relevant context for meeting "{meeting_title}"{meeting_date_context}\n\n'
            f'{important_msg}\n\n'
            f'CRITICAL: Focus on RELATIONSHIPS, PROGRESS, and BLOCKERS - not just topics.\n\n'
            f'NOTE: Emails may include thread metadata (_threadInfo) showing conversation flow, participant count, and date range. Use this to understand context better.\n\n'
            f'Return a detailed JSON object:\n'
            f'{{\n'
            f'  "workingRelationships": ["{perspective_str} relationships with others? Collaborative history? Authority/decision-making dynamics?"],\n'
            f'  "projectProgress": ["What\'s been accomplished? Current status? Timeline mentions? Milestones?"],\n'
            f'  "blockers": ["What\'s blocking progress? Unresolved questions? Pending decisions? Dependencies?"],\n'
            f'  "decisions": ["What decisions have been made? By whom? When? Impact?"],\n'
            f'  "actionItems": ["{action_items_q} By when? Current status?"],\n'
            f'  "topics": ["Main discussion topics, agenda items, key themes"],\n'
            f'  "keyContext": ["Other important context: document references, past meetings, external dependencies"],\n'
            f'  "attachments": ["Email attachments mentioned or referenced (filename, type, relevance)"],\n'
            f'  "sentiment": ["Communication tone: collaborative, tense, urgent, positive, negative, neutral. Flag any conflict indicators."]\n'
            f'}}\n\n'
            f'Be THOROUGH and SPECIFIC: Include names, dates, document references, patterns across emails.\n'
            f'Each point should be 15-80 words with concrete details. Structure everything from {user_ref} perspective.'
        )
    }, {
        'role': 'user',
        'content': f'Emails:\n\n' + '\n\n---\n\n'.join(email_content_list)
    }], 4000)

    try:
        batch_data = safe_parse_json(topics_extraction)
        return batch_data
    except Exception as e:
        logger.info(f'  ⚠️  Failed to parse topics extraction for batch {batch_index + 1}: {str(e)}', requestId=request_id)
        return None


async def filter_relevant_emails(
    emails: List[Dict[str, Any]],
    meeting_title: str,
    meeting_date_context: str,
    meeting_context: Optional[Dict[str, Any]],
    user_context: Optional[Dict[str, Any]],
    attendees: List[Dict[str, Any]],
    purpose_result: Optional[Dict[str, Any]] = None,
    request_id: str = 'unknown'
) -> Tuple[List[Dict[str, Any]], str, Dict[str, Any]]:
    """
    Filter emails for meeting relevance and extract context
    
    Args:
        emails: List of email objects
        meeting_title: Meeting title
        meeting_date_context: Formatted meeting date context string
        meeting_context: Meeting context understanding (optional)
        user_context: User context object (optional)
        attendees: List of attendee objects
        purpose_result: Detected meeting purpose result (optional)
        request_id: Request ID for logging
    
    Returns:
        Tuple of (relevant_emails, email_analysis, extraction_data)
        extraction_data contains: emailRelevanceReasoning, meetingContext, relevantContent
    """
    logger.info(f'\n  📧 Analyzing email threads for meeting context...', requestId=request_id)
    
    email_analysis = ''
    relevant_emails = []
    extraction_data = {
        'emailRelevanceReasoning': {},
        'meetingContext': meeting_context,
        'relevantContent': {'emails': []}
    }

    if not emails:
        email_analysis = 'No email activity found.'
        return relevant_emails, email_analysis, extraction_data

    # PRE-FILTER: Attendee overlap filtering (75%/50% rule)
    logger.info(f'  🔍 Pre-filtering {len(emails)} emails by attendee overlap...', requestId=request_id)
    attendee_filtered_emails = filter_emails_by_attendee_overlap(emails, attendees)
    logger.info(f'  ✓ Attendee overlap filter: {len(attendee_filtered_emails)}/{len(emails)} emails passed', requestId=request_id)
    
    # If no emails pass attendee filter, still proceed with all emails (fallback)
    if not attendee_filtered_emails and len(emails) > 0:
        logger.warn(f'  ⚠️  No emails passed attendee overlap filter, proceeding with all emails', requestId=request_id)
        attendee_filtered_emails = emails

    logger.info(f'  🔍 Filtering {len(attendee_filtered_emails)} emails for meeting relevance...', requestId=request_id)

    # PASS 1: Relevance filtering in PARALLEL batches of 25
    batch_size = 25
    batches = []
    for batch_start in range(0, len(attendee_filtered_emails), batch_size):
        batches.append({
            'start': batch_start,
            'end': min(batch_start + batch_size, len(attendee_filtered_emails)),
            'emails': attendee_filtered_emails[batch_start:min(batch_start + batch_size, len(attendee_filtered_emails))]
        })

    logger.info(f'  🚀 Processing {len(batches)} email batches...', requestId=request_id)

    relevance_promises = [
        _filter_email_batch(
            batch, i, len(batches), meeting_title, meeting_date_context,
            meeting_context, user_context, attendees, purpose_result, request_id
        )
        for i, batch in enumerate(batches)
    ]

    # Execute all relevance checks in parallel
    relevance_results = await asyncio.gather(*relevance_promises)
    all_relevant_indices = []
    all_relevance_reasoning = {}
    
    for result in relevance_results:
        all_relevant_indices.extend(result['indices'])
        all_relevance_reasoning.update(result['reasoning'])

    extraction_data['emailRelevanceReasoning'] = all_relevance_reasoning

    logger.info(f'  ✓ Total relevant emails: {len(all_relevant_indices)}/{len(attendee_filtered_emails)}', requestId=request_id)

    if not all_relevant_indices:
        email_analysis = f'No email threads found directly related to "{meeting_title}".'
        return relevant_emails, email_analysis, extraction_data

    # Get relevant emails (use attendee_filtered_emails as source)
    relevant_emails = []
    for idx in all_relevant_indices:
        if idx < len(attendee_filtered_emails):
            email = attendee_filtered_emails[idx].copy()
            email['_relevanceReasoning'] = all_relevance_reasoning.get(idx, 'Included based on meeting relevance')
            email['_relevanceIndex'] = idx
            relevant_emails.append(email)

    # Store relevant content for UI with reasoning
    extraction_data['relevantContent']['emails'] = [
        {
            'subject': e.get('subject', ''),
            'from': e.get('from', ''),
            'to': e.get('to', ''),
            'date': e.get('date', ''),
            'snippet': e.get('snippet') or (e.get('body') or '')[:200],
            'relevanceReasoning': all_relevance_reasoning.get(e.get('_relevanceIndex', -1), e.get('_relevanceReasoning', 'Relevant to meeting context - includes attendees or discusses related topics')),
            'relevanceScore': e.get('_temporalScore', 0.8),
            'daysOld': e.get('_daysOld'),
            'body': (e.get('body') or e.get('snippet') or '')[:1000]
        }
        for e in relevant_emails
    ]

    # Apply temporal scoring to rank emails by recency + relevance
    logger.info(f'  ⏰ Applying temporal scoring to {len(relevant_emails)} emails...', requestId=request_id)
    relevant_emails = score_and_rank_emails(relevant_emails, meeting_date=None)

    # Log temporal distribution
    recent_count = sum(1 for e in relevant_emails if e.get('_daysOld') is not None and e.get('_daysOld') <= 30)
    old_count = sum(1 for e in relevant_emails if e.get('_daysOld') is not None and e.get('_daysOld') > 180)
    logger.info(f'  📊 Email temporal distribution: {recent_count} from last 30 days, {old_count} older than 6 months', requestId=request_id)

    # Group emails by thread (subject + key participants)
    thread_map = {}
    for email in relevant_emails:
        subject = email.get('subject') or 'No Subject'
        from_addr = (email.get('from') or '').lower()
        to_addr = (email.get('to') or '').lower()
        
        # Create thread key from subject (normalized) and participants
        thread_key = re.sub(r'^(re:|fwd?:|fw:)\s*', '', subject.lower(), flags=re.IGNORECASE).strip()
        participants_list = [from_addr] + [e.strip().lower() for e in to_addr.split(',') if e.strip()]
        participants_list = sorted([p for p in participants_list if p])
        participants = '|'.join(participants_list)
        full_thread_key = f'{thread_key}::{participants}'

        if full_thread_key not in thread_map:
            thread_map[full_thread_key] = {
                'subject': subject,
                'emails': [],
                'participants': set(),
                'dateRange': {'earliest': None, 'latest': None}
            }

        thread = thread_map[full_thread_key]
        thread['emails'].append(email)
        if from_addr:
            thread['participants'].add(from_addr)
        for e in to_addr.split(','):
            email_addr = e.strip().lower()
            if email_addr:
                thread['participants'].add(email_addr)

        email_date = None
        if email.get('date'):
            email_date = parse_email_date(email['date'])

        if email_date:
            if not thread['dateRange']['earliest'] or email_date < thread['dateRange']['earliest']:
                thread['dateRange']['earliest'] = email_date
            if not thread['dateRange']['latest'] or email_date > thread['dateRange']['latest']:
                thread['dateRange']['latest'] = email_date

    # Add thread metadata to emails for context extraction
    relevant_emails_with_threads = []
    for email in relevant_emails:
        subject = email.get('subject') or 'No Subject'
        from_addr = (email.get('from') or '').lower()
        to_addr = (email.get('to') or '').lower()
        
        thread_key = re.sub(r'^(re:|fwd?:|fw:)\s*', '', subject.lower(), flags=re.IGNORECASE).strip()
        participants_list = [from_addr] + [e.strip().lower() for e in to_addr.split(',') if e.strip()]
        participants_list = sorted([p for p in participants_list if p])
        participants = '|'.join(participants_list)
        full_thread_key = f'{thread_key}::{participants}'
        
        thread = thread_map.get(full_thread_key)
        
        email_with_thread = email.copy()
        if thread:
            email_with_thread['_threadInfo'] = {
                'messageCount': len(thread['emails']),
                'participants': list(thread['participants']),
                'dateRange': thread['dateRange']
            }
        else:
            email_with_thread['_threadInfo'] = None
        
        relevant_emails_with_threads.append(email_with_thread)

    relevant_emails = relevant_emails_with_threads
    logger.info(f'  📧 Grouped into {len(thread_map)} email threads', requestId=request_id)

    logger.info(f'  📊 Extracting context from {len(relevant_emails)} relevant emails...', requestId=request_id)

    # PASS 2: Extract context in PARALLEL batches of 20
    extraction_batch_size = 20
    extraction_batches = []
    for batch_start in range(0, len(relevant_emails), extraction_batch_size):
        extraction_batches.append({
            'start': batch_start,
            'end': min(batch_start + extraction_batch_size, len(relevant_emails)),
            'emails': relevant_emails[batch_start:min(batch_start + extraction_batch_size, len(relevant_emails))]
        })

    extraction_promises = [
        _extract_context_batch(
            batch, i, len(extraction_batches), meeting_title,
            meeting_date_context, user_context, request_id
        )
        for i, batch in enumerate(extraction_batches)
    ]

    # Execute all context extractions in parallel
    all_extracted_data = [d for d in await asyncio.gather(*extraction_promises) if d is not None]

    # Merge all batch results with deduplication
    extracted_data_dict = {
        'workingRelationships': [],
        'projectProgress': [],
        'blockers': [],
        'decisions': [],
        'actionItems': [],
        'topics': [],
        'keyContext': [],
        'attachments': []
    }

    for batch_data in all_extracted_data:
        if batch_data:
            for key in extracted_data_dict.keys():
                if isinstance(batch_data.get(key), list):
                    extracted_data_dict[key].extend(batch_data[key])

    # Deduplicate all arrays
    for key in extracted_data_dict.keys():
        extracted_data_dict[key] = _deduplicate_array(extracted_data_dict[key])

    total_before_dedup = sum(len(arr) for arr in extracted_data_dict.values())
    total_after_dedup = sum(len(arr) for arr in extracted_data_dict.values())
    logger.info(f'  ✓ Deduplicated extracted data: {total_before_dedup} items → {total_after_dedup} unique items', requestId=request_id)

    logger.info(
        f'  ✓ Extracted context: {len(extracted_data_dict["workingRelationships"])} relationships, '
        f'{len(extracted_data_dict["decisions"])} decisions, {len(extracted_data_dict["blockers"])} blockers',
        requestId=request_id
    )

    # PASS 3: Synthesize into narrative
    extracted_data_str = json.dumps(extracted_data_dict, indent=2)
    estimated_tokens = len(extracted_data_str) // 4
    token_budget = 8000
    needs_truncation = estimated_tokens > token_budget

    user_context_prefix = ''
    if user_context:
        user_context_prefix = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). '

    # Build the important section for synthesis
    important_section = ''
    if user_context:
        important_section = f'IMPORTANT: Structure this analysis from {user_context["formattedName"]}\'s perspective. Use "you" to refer to {user_context["formattedName"]}. Focus on what {user_context["formattedName"]} needs to know.'

    truncation_note = ''
    if needs_truncation:
        truncation_note = 'NOTE: Data has been truncated to fit token budget. Prioritize most recent and most relevant information.'

    # Build the data string (with possible truncation)
    if needs_truncation:
        data_to_use = extracted_data_str[:token_budget * 4] + '\n\n[...data truncated for token budget...]'
    else:
        data_to_use = extracted_data_str

    # Build priority 1 text
    priority1 = "Start with HOW people work together"
    if user_context:
        priority1 = f"Start with {user_context['formattedName']}'s relationships with others and how people work together"

    # Build priority 4 action text
    priority4_action = "Who needs to do what?"
    if user_context:
        priority4_action = f"What does {user_context['formattedName']} need to do? What do others need to do?"

    # Build briefing target
    briefing_target = "an executive"
    if user_context:
        briefing_target = user_context["formattedName"]

    # Build user reference
    user_ref = "the user"
    if user_context:
        user_ref = user_context["formattedName"]

    email_summary = await call_gpt([{
        'role': 'system',
        'content': (
            f'{user_context_prefix}You are creating a comprehensive email analysis for meeting prep. Synthesize the extracted data into a detailed, insightful paragraph (8-12 sentences).\n\n'
            f'{important_section}\n\n'
            f'{truncation_note}\n\n'
            f'Extracted Data:\n'
            f'{data_to_use}\n\n'
            f'CRITICAL PRIORITIES (in order):\n'
            f'1. **Working Relationships**: {priority1}\n'
            f'2. **Progress & Status**: What\'s been accomplished? What\'s the current state?\n'
            f'3. **Blockers & Issues**: What\'s preventing progress?\n'
            f'4. **Decisions & Actions**: What\'s been decided? {priority4_action}\n'
            f'5. **Context**: Documents, past meetings, external factors\n\n'
            f'Guidelines:\n'
            f'- Write as if briefing {briefing_target} before a critical meeting\n'
            f'- Be SPECIFIC: include names, dates, document names, numbers\n'
            f'- Connect dots: show cause-effect, before-after, who-said-what\n'
            f'- Avoid generic statements - say HOW and WHY\n'
            f'- Every sentence must add actionable insight\n'
            f'- Use "you" to refer to {user_ref}'
        )
    }, {
        'role': 'user',
        'content': f'Meeting: {meeting_title}{meeting_date_context}\n\nCreate comprehensive email analysis paragraph.'
    }], 4000)

    email_analysis = email_summary.strip() if email_summary else 'Limited email context available.'
    logger.info(f'  ✓ Email analysis: {len(email_analysis)} chars from {len(relevant_emails)} relevant emails', requestId=request_id)

    return relevant_emails, email_analysis, extraction_data