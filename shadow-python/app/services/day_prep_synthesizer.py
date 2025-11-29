"""
Day Prep Synthesizer

Synthesizes multiple meeting briefs into a comprehensive day prep using Shadow persona
"""

import json
from datetime import datetime
from typing import Dict, List, Any, Optional
from app.services.gpt_service import call_gpt
from app.services.logger import logger
from app.services.user_context import get_user_context
from app.services.intelligent_day_aggregation import intelligently_aggregate


def extract_section(text: str, start_marker: str, end_marker: str) -> str:
    """Extract a section from narrative text"""
    start_idx = text.lower().find(start_marker.lower())
    if start_idx == -1:
        return ''
    
    end_idx = text.lower().find(end_marker.lower(), start_idx + len(start_marker))
    if end_idx == -1:
        return text[start_idx:].strip()
    
    return text[start_idx:end_idx].strip()


async def synthesize_day_prep(
    selected_date: datetime,
    meetings: List[Dict[str, Any]],
    briefs: List[Dict[str, Any]],
    request_id: str = None,
    user: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Synthesize day prep from multiple meeting briefs
    Args:
        selected_date: The date for day prep
        meetings: Array of meeting objects
        briefs: Array of meeting brief objects
        request_id: Request ID for logging
        user: User object (optional, for user context)
    Returns:
        Day prep object with narrative and structure
    """
    try:
        logger.info(f'Synthesizing day prep', requestId=request_id, meetingCount=len(meetings), briefCount=len(briefs))

        # Format date - use the date as-is (already in local timezone)
        date_str = selected_date.strftime('%A, %B %d, %Y')

        # Group meetings by time blocks
        morning_meetings = []
        midday_meetings = []
        afternoon_meetings = []

        for meeting, brief in zip(meetings, briefs + [None] * (len(meetings) - len(briefs))):
            if not isinstance(meeting, dict):
                continue
            start_time = meeting.get('start', {}).get('dateTime') if isinstance(meeting.get('start'), dict) else (meeting.get('start', {}).get('date') if isinstance(meeting.get('start'), dict) else meeting.get('start'))
            if not start_time:
                continue

            try:
                hour = datetime.fromisoformat(start_time.replace('Z', '+00:00')).hour
            except:
                hour = 12  # Default to midday if parsing fails

            meeting_info = {
                'title': meeting.get('summary') or meeting.get('title') or 'Untitled Meeting',
                'time': datetime.fromisoformat(start_time.replace('Z', '+00:00')).strftime('%I:%M %p') if start_time else 'Time TBD',
                'attendees': meeting.get('attendees', []),
                'brief': brief
            }

            if hour < 12:
                morning_meetings.append(meeting_info)
            elif hour < 17:
                midday_meetings.append(meeting_info)
            else:
                afternoon_meetings.append(meeting_info)

        # Build comprehensive context for Shadow persona
        meeting_context = []
        for meeting, brief in zip(meetings, briefs + [None] * (len(meetings) - len(briefs))):
            if not isinstance(meeting, dict):
                continue
            start_time_obj = meeting.get('start')
            if isinstance(start_time_obj, dict):
                start_time = start_time_obj.get('dateTime') or start_time_obj.get('date')
            else:
                start_time = start_time_obj
            
            # Extract full attendee details with keyFacts from brief
            brief_attendees = brief.get('attendees', []) if (brief and isinstance(brief, dict)) else []
            meeting_attendees = meeting.get('attendees', [])
            
            # Merge attendees: prefer brief attendees (with keyFacts), fallback to meeting attendees
            all_attendees = brief_attendees if brief_attendees else [
                {
                    'name': a.get('displayName') or a.get('email') or 'Unknown',
                    'email': a.get('email') or a.get('emailAddress'),
                    'company': a.get('company') or (a.get('email', '').split('@')[1] if '@' in (a.get('email') or '') else 'Unknown'),
                    'title': a.get('title', ''),
                    'keyFacts': []
                }
                for a in meeting_attendees if isinstance(a, dict)
            ]
            
            meeting_context.append({
                'title': meeting.get('summary') or meeting.get('title') or 'Untitled Meeting',
                'time': datetime.fromisoformat(start_time.replace('Z', '+00:00')).strftime('%I:%M %p') if start_time else 'Time TBD',
                'attendees': [
                    {
                        'name': a.get('name') or a.get('displayName') or a.get('email') or 'Unknown',
                        'email': a.get('email') or a.get('emailAddress'),
                        'company': a.get('company') or ((a.get('email', '').split('@')[1] if '@' in (a.get('email') or '') else 'Unknown')),
                        'title': a.get('title', ''),
                        'keyFacts': a.get('keyFacts', [])
                    }
                    for a in all_attendees
                ],
                'summary': brief.get('summary', '') if (brief and isinstance(brief, dict)) else '',
                'relationshipAnalysis': brief.get('relationshipAnalysis', '') if (brief and isinstance(brief, dict)) else '',
                'emailAnalysis': brief.get('emailAnalysis', '') if (brief and isinstance(brief, dict)) else '',
                'documentAnalysis': brief.get('documentAnalysis', '') if (brief and isinstance(brief, dict)) else '',
                'companyResearch': brief.get('companyResearch', '') if (brief and isinstance(brief, dict)) else '',
                'contributionAnalysis': brief.get('contributionAnalysis', '') if (brief and isinstance(brief, dict)) else '',
                'broaderNarrative': brief.get('broaderNarrative', '') if (brief and isinstance(brief, dict)) else '',
                'recommendations': brief.get('recommendations', []) if (brief and isinstance(brief, dict)) else [],
                'actionItems': brief.get('actionItems', []) if (brief and isinstance(brief, dict)) else [],
                'timeline': brief.get('timeline', []) if (brief and isinstance(brief, dict)) else [],
                'keyPoints': (brief.get('actionItems', [])[:5] if (brief and isinstance(brief, dict)) else []),
                'context': brief.get('context', {}) if (brief and isinstance(brief, dict)) else {}
            })

        meeting_context = [m for m in meeting_context if isinstance(m, dict) and (m.get('title') != 'Untitled Meeting' or m.get('summary'))]
        
        # Aggregate all unique attendees across all meetings with their keyFacts
        attendee_map = {}
        for m in meeting_context:
            if not isinstance(m, dict):
                continue
            for att in m.get('attendees', []):
                if not isinstance(att, dict):
                    continue
                email = (att.get('email') or '').lower()
                if email and email not in attendee_map:
                    attendee_map[email] = {
                        'name': att.get('name'),
                        'email': att.get('email'),
                        'company': att.get('company'),
                        'title': att.get('title'),
                        'keyFacts': att.get('keyFacts', [])
                    }
                elif email and email in attendee_map:
                    # Merge keyFacts if attendee appears in multiple meetings
                    existing = attendee_map[email]
                    new_facts = att.get('keyFacts', [])
                    existing['keyFacts'] = list(set(existing['keyFacts'] + new_facts))
        
        aggregated_attendees = list(attendee_map.values())
        
        # Extract all attendee names for transcription hints
        all_attendee_names = []
        for a in aggregated_attendees:
            if not isinstance(a, dict):
                continue
            name = a.get('name') or ''
            parts = name.split()
            all_attendee_names.extend([name, parts[0], parts[-1]] if len(parts) > 1 else [name])
        all_attendee_names = list(dict.fromkeys(all_attendee_names))  # Remove duplicates while preserving order
        
        # Intelligently aggregate context across all meetings
        intelligent_aggregation = await intelligently_aggregate([b for b in briefs if b and isinstance(b, dict)])
        
        # Build aggregated context with intelligent insights
        if not isinstance(intelligent_aggregation, dict):
            intelligent_aggregation = {}
        aggregated_context = {
            'relationshipAnalysis': intelligent_aggregation.get('relationshipAnalysis', '') if isinstance(intelligent_aggregation, dict) else '',
            'emailAnalysis': intelligent_aggregation.get('emailAnalysis', '') if isinstance(intelligent_aggregation, dict) else '',
            'documentAnalysis': intelligent_aggregation.get('documentAnalysis', '') if isinstance(intelligent_aggregation, dict) else '',
            'companyResearch': '\n\n'.join([m.get('companyResearch', '') for m in meeting_context if isinstance(m, dict) and m.get('companyResearch')]),
            'contributionAnalysis': '\n\n'.join([m.get('contributionAnalysis', '') for m in meeting_context if isinstance(m, dict) and m.get('contributionAnalysis')]),
            'broaderNarrative': '\n\n'.join([m.get('broaderNarrative', '') for m in meeting_context if isinstance(m, dict) and m.get('broaderNarrative')]),
            'recommendations': list(set([r for m in meeting_context if isinstance(m, dict) for r in (m.get('recommendations') or [])])),
            'actionItems': intelligent_aggregation.get('actionItems', []) if isinstance(intelligent_aggregation, dict) else [],
            'timeline': intelligent_aggregation.get('timeline', []) if isinstance(intelligent_aggregation, dict) else [],
            'conflicts': intelligent_aggregation.get('conflicts', []) if isinstance(intelligent_aggregation, dict) else [],
            'themes': intelligent_aggregation.get('themes', []) if isinstance(intelligent_aggregation, dict) else [],
            'keyPeople': intelligent_aggregation.get('keyPeople', []) if isinstance(intelligent_aggregation, dict) else [],
            'dependencies': intelligent_aggregation.get('dependencies', []) if isinstance(intelligent_aggregation, dict) else []
        }

        # Get user context
        user_name = user.get('name') if user else 'the user'
        user_email = user.get('email') if user else ''
        
        # Generate dynamic prompt structure using GPT
        import httpx
        import os
        
        prompt_structure = None
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    'https://api.openai.com/v1/chat/completions',
                    headers={
                        'Content-Type': 'application/json',
                        'Authorization': f"Bearer {os.getenv('OPENAI_API_KEY')}"
                    },
                    json={
                        'model': 'gpt-4.1-mini',
                        'temperature': 0.7,
                        'messages': [
                            {
                                'role': 'system',
                                'content': """You are an expert at creating system prompts for voice AI assistants. Generate a comprehensive, well-structured system prompt framework for Shadow's day prep mode.

The prompt structure should:
1. Include transcription hints section (with placeholder for attendee names)
2. Include Shadow's role and persona for day prep
3. Include briefing instructions (5-7 minutes, 750-1000 words, concise, Shadow's style)
4. Include interruption handling rules
5. Include response format requirements
6. Be well-structured and comprehensive

Format: Return ONLY the system prompt structure text with placeholders like [ATTENDEE_NAMES], [DATE], [USER_NAME], etc. No markdown, no explanations."""
                            },
                            {
                                'role': 'user',
                                'content': f"""Generate a system prompt structure for Shadow's day prep mode briefing {user_name} about their day.

DAY OVERVIEW:
- Date: [DATE]
- Meeting Count: {len(meeting_context)}
- Attendee Count: {len(aggregated_attendees)}
- Companies: {', '.join(set([a.get('company') for a in aggregated_attendees if isinstance(a, dict) and a.get('company')])) or 'Various'}

The structure should include placeholders for:
- [ATTENDEE_NAMES] - list of all attendee names for transcription hints
- [DATE] - the date string
- [USER_NAME] - user's name
- [USER_EMAIL] - user's email
- [MEETING_CONTEXT_SECTION] - comprehensive meeting context section
- [AGGREGATED_CONTEXT_SECTION] - aggregated context from all meetings

Generate a comprehensive system prompt structure for Shadow's day prep mode."""
                            }
                        ],
                        'max_tokens': 800
                    }
                )
                
                if response.is_success:
                    data = response.json()
                    prompt_structure = data['choices'][0]['message']['content'].strip()
                    logger.info('Generated dynamic day prep prompt structure using GPT', requestId=request_id)
        except Exception as error:
            logger.warn(f'Failed to generate dynamic prompt structure, using fallback: {str(error)}', requestId=request_id)
            prompt_structure = None
        
        # Build comprehensive meeting context section
        def format_attendee(a):
            """Format attendee information without nested f-strings"""
            if not isinstance(a, dict):
                return ''
            name = a.get('name', '')
            company_part = f" ({a.get('company', '')})" if a.get('company') else ''
            title_part = f" - {a.get('title', '')}" if a.get('title') else ''
            return f"{name}{company_part}{title_part}"
        
        meeting_context_section = '\n---\n'.join([
            f"""Meeting {i + 1}: {m.get('title', 'Untitled')}
Time: {m.get('time', 'TBD')}
Attendees: {', '.join([format_attendee(a) for a in m.get('attendees', []) if isinstance(a, dict)])}
{f"Summary: {m.get('summary', '')}" if isinstance(m, dict) and m.get('summary') else ''}
{f"Key Action Items: {'; '.join(m.get('keyPoints', []))}" if isinstance(m, dict) and m.get('keyPoints') else ''}
{f"Relationship Context: {m.get('relationshipAnalysis', '')[:400]}" if isinstance(m, dict) and m.get('relationshipAnalysis') else ''}
{f"Email Context: {m.get('emailAnalysis', '')[:400]}" if isinstance(m, dict) and m.get('emailAnalysis') else ''}
{f"Document Context: {m.get('documentAnalysis', '')[:400]}" if isinstance(m, dict) and m.get('documentAnalysis') else ''}
{f"Company Research: {m.get('companyResearch', '')[:400]}" if isinstance(m, dict) and m.get('companyResearch') else ''}
{f"Recommendations: {'; '.join(m.get('recommendations', []))}" if isinstance(m, dict) and m.get('recommendations') else ''}"""
            for i, m in enumerate(meeting_context)
            if isinstance(m, dict)
        ])
        
        # Build aggregated context section
        # Build recommendations string (avoid backslash in f-string)
        recommendations_list = aggregated_context.get('recommendations', [])
        recommendations_str = '\n• '.join(recommendations_list) if recommendations_list else 'None provided.'
        
        # Build action items string (avoid backslash in f-string)
        action_items_list = aggregated_context.get('actionItems', [])
        action_items_str = '\n• '.join(action_items_list) if action_items_list else 'None provided.'
        
        # Build timeline events string
        timeline_events = aggregated_context.get('timeline', [])[:10]
        timeline_events_str = '\n'.join([
            f"{idx + 1}. [{event.get('date') or (event.get('start', {}).get('dateTime') if isinstance(event.get('start'), dict) else '') or 'Date unknown'}] {event.get('type', 'event')}: {event.get('title') or event.get('summary') or 'Untitled'}"
            for idx, event in enumerate(timeline_events)
            if isinstance(event, dict)
        ]) if timeline_events else 'No timeline events available.'
        
        aggregated_context_section = f"""
AGGREGATED CONTEXT ACROSS ALL MEETINGS:

Relationship Analysis:
{aggregated_context.get('relationshipAnalysis') or 'No relationship analysis available.'}

Email Context:
{aggregated_context.get('emailAnalysis') or 'No email context available.'}

Document Context:
{aggregated_context.get('documentAnalysis') or 'No document context available.'}

Company Research:
{aggregated_context.get('companyResearch') or 'No company research available.'}

Contribution Analysis:
{aggregated_context.get('contributionAnalysis') or 'No contribution analysis available.'}

Broader Narrative:
{aggregated_context.get('broaderNarrative') or 'No broader narrative available.'}

Recommendations:
{recommendations_str}

Action Items:
{action_items_str}

Timeline Events:
{timeline_events_str}
"""
        
        # Build transcription hints
        transcription_hints = f"\n\nTRANSCRIPTION ACCURACY HINTS:\nWhen transcribing user speech, pay special attention to these names: {', '.join(all_attendee_names)}. These are meeting attendees and should be transcribed accurately.\n" if all_attendee_names else ''
        
        # Build sections for conflicts, themes, key people, and dependencies (avoid backslashes in f-strings)
        conflicts_list = aggregated_context.get('conflicts', [])
        conflicts_section = ''
        if conflicts_list:
            conflicts_lines = [f"- {c.get('meetings', [])}: {c.get('description', '')} ({c.get('severity', 'unknown')} severity)" for c in conflicts_list]
            conflicts_section = f"⚠️  CONFLICTS DETECTED ({len(conflicts_list)}):\n" + '\n'.join(conflicts_lines)
        
        themes_list = aggregated_context.get('themes', [])
        themes_section = ''
        if themes_list:
            themes_lines = [f"- {t.get('theme', '')}: Connects {', '.join(t.get('meetings', []))} - {t.get('description', '')}" for t in themes_list]
            themes_section = f"🎯 THEMATIC THREADS ({len(themes_list)}):\n" + '\n'.join(themes_lines)
        
        key_people_list = aggregated_context.get('keyPeople', [])
        key_people_section = ''
        if key_people_list:
            key_people_lines = [f"- {p.get('name', '')}: {p.get('roleAcrossMeetings', '')}" for p in key_people_list]
            key_people_section = f"👥 KEY PEOPLE ACROSS MEETINGS:\n" + '\n'.join(key_people_lines)
        
        dependencies_list = aggregated_context.get('dependencies', [])
        dependencies_section = ''
        if dependencies_list:
            dependencies_lines = [f"- {d.get('meeting', '')} depends on {d.get('dependsOn', '')}: {d.get('reason', '')}" for d in dependencies_list]
            dependencies_section = f"🔗 MEETING DEPENDENCIES:\n" + '\n'.join(dependencies_lines)
        
        # Use dynamic prompt structure or fallback
        if prompt_structure:
            shadow_prompt = prompt_structure.replace('[ATTENDEE_NAMES]', ', '.join(all_attendee_names)).replace('[DATE]', date_str).replace('[USER_NAME]', user_name).replace('[USER_EMAIL]', user_email).replace('[MEETING_CONTEXT_SECTION]', meeting_context_section).replace('[AGGREGATED_CONTEXT_SECTION]', aggregated_context_section) + transcription_hints
        else:
            # Fallback prompt
            # Build important message (avoid backslash in f-string)
            important_msg = ''
            if user:
                important_msg = f"IMPORTANT: You are preparing {user_name} ({user_email}) for their day. Use 'you' to refer to {user_name}. Structure everything from {user_name}'s perspective."
            
            shadow_prompt = f"""You are Shadow, {user_name}'s personalized, hyper-contextual, ultra-efficient executive assistant that helps prepare for meetings.

{important_msg}

Your job in this mode is to prepare {user_name} for their entire day with a clear, crisp, strategic start-of-day voice brief.

Shadow DOES NOT modify the calendar, reschedule events, propose moving meetings, or perform any editing actions.
Shadow ONLY:
- Prepares the user mentally and strategically
- Retrieves context from the user's digital memory (emails, chats, docs)
- Uses web search when necessary
- Acts as a sounding board
- Answers questions mid-brief
- Resumes seamlessly from where it left off

Shadow is designed to be quick, precise, calm, senior, and efficient.

Shadow must always sound like a calm, confident, senior Chief of Staff.
- No chatter.
- No enthusiasm padding.
- No emojis.
- No corporate buzzwords unless relevant.
- Every sentence must add value.

When generating the start-of-day brief:
- Target 5–7 minutes (~750–1000 words).
- Natural spoken tone; no bullets, no headings.
- Always speak as if the user is walking, driving, or getting ready.
- Prioritize only what changes decisions or behavior.
- Cluster the day in logical blocks: morning → midday → afternoon → end of day.

Focus on:
- Top 2–3 priorities of the day
- Critical meetings and decisions
- Strategic context for each important meeting
- Relationship dynamics
- Key risks and opportunities
- Mental preparation
- Time/energy hotspots
- Open loops that might affect the day

OUTPUT FORMAT
Shadow must output spoken narrative only, following this structure:

A. Orientation (30–45 seconds)
- Name the day
- Provide the overall "theme" or shape of the day
- Preview the type of meetings ahead

B. Morning Block (60–90 sec)
- Key meetings
- What matters most
- Decisions required
- People dynamics
- Risks + opportunities

C. Midday Block (60–90 sec)
- High-signal prep
- Open loops that affect these meetings
- Strategic framing

D. Afternoon / Evening Block (60–90 sec)
- External calls, partner discussions
- Mental posture
- Energy/flow considerations

E. Day's Win Condition (45 sec)
- Summarize what "success" looks like for the day
- Tie to weekly + long-term goals

F. Optional questions Shadow may ask
- Only if directly relevant and ONLY one question at a time
- No open-ended fluff.

Today is {date_str}.{transcription_hints}

MEETINGS FOR TODAY:
{meeting_context_section}

AGGREGATED CONTEXT:
{aggregated_context_section}

{conflicts_section}

{themes_section}

{key_people_section}

{dependencies_section}

Generate the day prep brief now. Speak naturally, as if you're briefing {user_name} while {'they' if user else 'the user'} are getting ready for {'their' if user else 'the'} day. Use "you" consistently to refer to {user_name}.

IMPORTANT: Use the conflicts, themes, key people, and dependencies to create a COHESIVE day narrative, not just a list of meetings. Connect the dots between meetings. Highlight strategic sequencing if dependencies exist."""

        response = await call_gpt([{
            'role': 'system',
            'content': shadow_prompt
        }], 2000)

        narrative = response if isinstance(response, str) else response.get('content', '') or response.get('text', '')

        logger.info(f'Day prep synthesized', requestId=request_id, narrativeLength=len(narrative))

        return {
            'summary': f'Day prep for {date_str}',
            'narrative': narrative,
            'structure': {
                'orientation': extract_section(narrative, 'Orientation', 'Morning'),
                'morning': extract_section(narrative, 'Morning', 'Midday'),
                'midday': extract_section(narrative, 'Midday', 'Afternoon'),
                'afternoon': extract_section(narrative, 'Afternoon', 'Win'),
                'winCondition': extract_section(narrative, 'Win', 'Optional')
            },
            'meetings': [b for b in briefs if b is not None and isinstance(b, dict)],
            'aggregatedAttendees': aggregated_attendees,
            'aggregatedContext': aggregated_context,
            'date': date_str,
            'attendeeNames': all_attendee_names
        }

    except Exception as error:
        logger.error(f'Error synthesizing day prep: {str(error)}', requestId=request_id)
        
        # Fallback: Simple summary
        fallback_date_str = selected_date.strftime('%A, %B %d, %Y')
        
        return {
            'summary': f'Day prep for {fallback_date_str}',
            'narrative': f"You have {len(meetings)} meeting{'s' if len(meetings) != 1 else ''} scheduled for today. {'Meeting briefs have been prepared.' if len(briefs) > 0 else 'Preparing meeting briefs...'}",
            'structure': {
                'orientation': '',
                'morning': '',
                'midday': '',
                'afternoon': '',
                'winCondition': ''
            },
            'meetings': [b for b in briefs if b is not None and isinstance(b, dict)],
            'aggregatedAttendees': [],
            'aggregatedContext': {
                'relationshipAnalysis': '',
                'emailAnalysis': '',
                'documentAnalysis': '',
                'companyResearch': '',
                'contributionAnalysis': '',
                'broaderNarrative': '',
                'recommendations': [],
                'actionItems': [],
                'timeline': []
            },
            'date': fallback_date_str,
            'attendeeNames': []
        }

