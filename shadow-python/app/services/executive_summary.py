"""
Executive Summary Service

Generates comprehensive executive summaries for meetings
Uses deep analysis of meeting purpose and context
"""

import json
from datetime import datetime
from typing import List, Dict, Any, Optional
from app.services.gpt_service import call_gpt, safe_parse_json, synthesize_results
from app.services.logger import logger


async def generate_executive_summary(
    meeting: Dict[str, Any],
    meeting_title: str,
    meeting_date_context: str,
    meeting_date: Optional[Dict[str, Any]],
    attendees: List[Dict[str, Any]],
    email_analysis: str,
    document_analysis: str,
    relationship_analysis: str,
    contribution_analysis: str,
    broader_narrative: str,
    timeline: List[Dict[str, Any]],
    timeline_trend: Optional[Dict[str, Any]],
    recommendations: List[str],
    user_context: Optional[Dict[str, Any]],
    request_id: str = 'unknown'
) -> str:
    """
    Generate executive summary for meeting
    
    Args:
        meeting: Meeting object
        meeting_title: Meeting title
        meeting_date_context: Formatted meeting date context string
        meeting_date: Meeting date object (optional)
        attendees: List of attendee research results
        email_analysis: Email analysis text
        document_analysis: Document analysis text
        relationship_analysis: Relationship analysis text
        contribution_analysis: Contribution analysis text
        broader_narrative: Broader narrative text
        timeline: List of timeline events
        timeline_trend: Timeline trend object (optional)
        recommendations: List of recommendations
        user_context: User context object (optional)
        request_id: Request ID for logging
    
    Returns:
        Executive summary text
    """
    logger.info(f'\n  📊 Generating executive summary...', requestId=request_id)

    # Step 1: Deep analysis of meeting purpose and context
    logger.info(f'  🔍 Step 1: Deeply analyzing meeting purpose and context...', requestId=request_id)

    user_context_prefix = ''
    if user_context:
        user_context_prefix = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). '

    # Format attendees for prompt
    attendees_text = '\n'.join([
        f'- {a.get("name", "")} ({a.get("company", "")})'
        + (f': {"; ".join(a.get("keyFacts", [])[:2])}' if isinstance(a, dict) and a.get('keyFacts') else '')
        for a in attendees if isinstance(a, dict)
    ])

    # Format timeline events
    timeline_text = ''
    if timeline_trend and isinstance(timeline_trend, dict):
        trend_type = timeline_trend.get("trend", "unknown")
        velocity = timeline_trend.get("velocity", 0)
        item_count = timeline_trend.get("itemCount", 0)
        if trend_type != 'insufficient_data':
            timeline_text = f'TREND: {trend_type} activity ({item_count} items, velocity: {velocity:.2f}/day)\n'
    if timeline:
        timeline_lines = []
        for e in timeline[:15]:
            if not isinstance(e, dict):
                continue
            date_str = 'unknown date'
            if e.get('date'):
                try:
                    date_obj = datetime.fromisoformat(e['date'].replace('Z', '+00:00'))
                    date_str = date_obj.strftime('%Y-%m-%d')
                except Exception:
                    pass
            timeline_lines.append(f'- {e.get("type", "")}: {e.get("name") or e.get("subject", "")} ({date_str})')
        timeline_text += '\n'.join(timeline_lines)
    else:
        timeline_text = 'Timeline events will be analyzed'

    # Truncate long analyses for prompt
    def truncate_text(text: str, max_length: int) -> str:
        if not text:
            return ''
        if len(text) <= max_length:
            return text
        return text[:max_length] + '\n[...truncated...]'

    # Prepare user context variables to avoid nested f-string issues
    user_name = user_context.get("formattedName", "the user") if user_context and isinstance(user_context, dict) else "the user"
    user_possessive = f"{user_context.get('formattedName', 'the user')}'s" if user_context and isinstance(user_context, dict) else "the user's"
    user_context_note = ''
    if user_context and isinstance(user_context, dict):
        user_context_note = f"IMPORTANT: {user_context.get('formattedName', 'the user')} is the user you are preparing this brief for. Analyze the meeting purpose from {user_context.get('formattedName', 'the user')}'s perspective. Focus on what {user_context.get('formattedName', 'the user')} needs to understand about this meeting.\n\n"
    user_info_line = f"User: {user_context.get('formattedName', 'Unknown')} ({user_context.get('formattedEmail', '')})\n" if user_context and isinstance(user_context, dict) else ""
    summary_context_note = ''
    if user_context and isinstance(user_context, dict):
        summary_context_note = f"IMPORTANT: {user_context.get('formattedName', 'the user')} is the user you are preparing this brief for. Structure the summary from {user_context.get('formattedName', 'the user')}'s perspective. Use \"you\" to refer to {user_context.get('formattedName', 'the user')}.\n\n"

    meeting_purpose_analysis = await call_gpt([{
        'role': 'system',
        'content': f'{user_context_prefix}You are an expert meeting analyst. Your task is to deeply understand WHY a meeting is happening and WHAT it\'s truly about from {user_possessive} perspective.\n\n'
        f'{user_context_note}'
        f'You have access to COMPREHENSIVE collated information:\n'
        f'- Email analysis (discussions, decisions, blockers)\n'
        f'- Document analysis (key insights, proposals, data)\n'
        f'- Relationship analysis (how people work together)\n'
        f'- Contribution analysis (who contributes what and how)\n'
        f'- Broader narrative (the complete story)\n'
        f'- Timeline (key events leading to this meeting)\n\n'
        f'CRITICAL ANALYSIS QUESTIONS:\n'
        f'1. **What is the meeting\'s core purpose from {user_possessive} perspective?** (Not just the title - what problem is it solving for {user_name}?)\n'
        f'2. **Why is this meeting happening NOW?** (What triggered it? What timeline pressure exists?)\n'
        f'3. **What questions need to be answered?** (What decisions need to be made? What information is needed?)\n'
        f'4. **What is the narrative leading to this meeting?** (What events, discussions, or decisions led here?)\n'
        f'5. **What are the stakes for {user_name}?** (What happens if this meeting goes well/poorly?)\n'
        f'6. **Who are the key players and what are their roles relative to {user_name}?** (Who drives? Who decides? Who contributes?)\n\n'
        f'Return a detailed JSON analysis:\n'
        f'{{\n'
        f'  "corePurpose": "What is this meeting really about for {user_name}? (2-3 sentences)",\n'
        f'  "whyNow": "Why is this happening at this specific time? (1-2 sentences)",\n'
        f'  "keyQuestions": ["Question 1", "Question 2", "Question 3"],\n'
        f'  "narrative": "The story leading to this meeting - what happened that made this meeting necessary? (3-5 sentences)",\n'
        f'  "stakes": "What are the consequences/importance for {user_name}? (1-2 sentences)",\n'
        f'  "keyPlayers": ["Who are the key contributors and what are their roles relative to {user_name}?"],\n'
        f'  "criticalContext": ["Most important context point 1", "Most important context point 2", ...]\n'
        f'}}'
    }, {
        'role': 'user',
        'content': f'Meeting: "{meeting_title}"{meeting_date_context}\n'
        f'Meeting Description: {meeting.get("description", "No description provided")}\n\n'
        f'{user_info_line}'
        f'Other Attendees:\n{attendees_text}\n\n'
        f'COMPREHENSIVE COLLATED INFORMATION:\n\n'
        f'Email Analysis:\n{truncate_text(email_analysis, 2500)}\n\n'
        f'Document Analysis:\n{truncate_text(document_analysis, 2000)}\n\n'
        f'Relationship Analysis:\n{truncate_text(relationship_analysis, 2000)}\n\n'
        f'Contribution Analysis:\n{truncate_text(contribution_analysis, 1500)}\n\n'
        f'Broader Narrative:\n{truncate_text(broader_narrative, 2000)}\n\n'
        f'Key Timeline Events (from broader narrative analysis):\n{timeline_text}\n\n'
        f'Analyze deeply: What is this meeting REALLY about? Use ALL the collated information to understand the complete picture. Consider the timeline trend when analyzing momentum and urgency.'
    }], 4000)

    purpose_data = {}
    try:
        parsed = safe_parse_json(meeting_purpose_analysis)
        if parsed and isinstance(parsed, dict):
            purpose_data = parsed
            core_purpose_preview = purpose_data.get('corePurpose', '')[:100] if purpose_data.get('corePurpose') else 'analysis complete'
            logger.info(f'  ✓ Meeting purpose analyzed: {core_purpose_preview}...', requestId=request_id)
        else:
            logger.warn(f'  ⚠️  Could not parse meeting purpose analysis, using raw text', requestId=request_id)
            purpose_data['corePurpose'] = meeting_purpose_analysis
    except Exception as e:
        logger.error(f'  ⚠️  Failed to parse meeting purpose analysis: {str(e)}', requestId=request_id)
        purpose_data['corePurpose'] = meeting_purpose_analysis or 'Meeting purpose analysis unavailable'

    # Step 2: Generate executive summary based on deep analysis
    logger.info(f'  ✍️  Step 2: Generating executive summary from analysis...', requestId=request_id)

    user_context_prefix2 = ''
    if user_context:
        user_context_prefix2 = f'You are preparing a brief for {user_context["formattedName"]} ({user_context["formattedEmail"]}). '

    # Format timeline for synthesis
    timeline_for_synthesis = []
    for e in timeline[:15]:
        if not isinstance(e, dict):
            continue
        timeline_for_synthesis.append({
            'type': e.get('type', ''),
            'date': e.get('date', ''),
            'name': e.get('name') or e.get('subject', ''),
            'snippet': e.get('snippet') or e.get('description', '')
        })

    # Format attendees for synthesis
    attendees_for_synthesis = [
        {
            'name': a.get('name', ''),
            'title': a.get('title', ''),
            'company': a.get('company', ''),
            'keyFacts': a.get('keyFacts', [])[:3] if isinstance(a, dict) and a.get('keyFacts') else []
        }
        for a in attendees if isinstance(a, dict)
    ]

    summary = await synthesize_results(
        f'{user_context_prefix2}You are creating an executive summary for the meeting: "{meeting_title}"{meeting_date_context}\n\n'
        f'{summary_context_note}'
        f'DEEP ANALYSIS OF MEETING PURPOSE:\n'
        f'{json.dumps(purpose_data, indent=2)}\n\n'
        f'COMPREHENSIVE COLLATED CONTEXT:\n\n'
        f'Email Analysis:\n{truncate_text(email_analysis, 2000)}\n\n'
        f'Document Analysis:\n{truncate_text(document_analysis, 1500)}\n\n'
        f'Relationship Analysis:\n{truncate_text(relationship_analysis, 1500)}\n\n'
        f'Contribution Analysis:\n{truncate_text(contribution_analysis, 1200)}\n\n'
        f'Broader Narrative:\n{truncate_text(broader_narrative, 1500)}\n\n'
        f'CRITICAL REQUIREMENTS:\n'
        f'1. **Answer WHY this meeting exists for {user_name}**: Use the "narrative" and "whyNow" from the analysis above\n'
        f'2. **Be SPECIFIC**: Reference actual people, documents, dates, decisions from the context\n'
        f'3. **Tell the STORY**: Explain the journey that led to this meeting (use the "narrative" field)\n'
        f'4. **Highlight STAKES**: What matters here for {user_name}? (use the "stakes" field)\n'
        f'5. **Reference KEY QUESTIONS**: What needs to be answered? (use "keyQuestions")\n'
        f'6. **TEMPORAL ACCURACY**: This meeting is on {meeting_date.get("readable", "the scheduled date") if (meeting_date and isinstance(meeting_date, dict)) else "the scheduled date"}. Ground everything in the correct timeframe.\n'
        f'7. **USER PERSPECTIVE**: Write from {user_possessive} perspective. Use "you" to refer to {user_name}.\n\n'
        f'STRUCTURE (4-5 sentences):\n'
        f'- Sentence 1: {"You are meeting with" if user_context else "WHO is meeting"} and WHAT is the core purpose (use "corePurpose" from analysis)\n'
        f'- Sentence 2: THE NARRATIVE - What happened that led to this meeting? (use "narrative" field)\n'
        f'- Sentence 3: KEY CONTEXT - What specific information from emails/docs frames this discussion?\n'
        f'- Sentence 4: CURRENT STATE - What questions need answers? What blockers exist? (use "keyQuestions")\n'
        f'- Sentence 5: WHY IT MATTERS - What are the stakes for {"you" if user_context else user_name}? Why now? (use "stakes" and "whyNow")\n\n'
        f'Write as if briefing {"an executive" if not user_context else user_context["formattedName"]} who needs to understand not just WHAT the meeting is about, but WHY it\'s happening and WHAT needs to happen. Make it compelling and specific. Use "you" consistently to refer to {"the user" if not user_context else user_context["formattedName"]}.',
        {
            'meeting': {
                'title': meeting_title,
                'description': meeting.get('description', ''),
                'purposeAnalysis': purpose_data
            },
            'attendees': attendees_for_synthesis,
            'emailAnalysis': email_analysis or 'No email context',
            'documentAnalysis': document_analysis or 'No document analysis',
            'relationshipAnalysis': relationship_analysis or 'No relationship analysis',
            'timeline': timeline_for_synthesis,
            'timelineTrend': timeline_trend,
            'recommendations': recommendations[:3] if recommendations else []
        },
        1000
    )

    logger.info(f'  ✓ Executive summary: {len(summary) if summary else 0} chars', requestId=request_id)

    return summary or ''

