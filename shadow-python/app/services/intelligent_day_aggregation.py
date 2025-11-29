"""
Intelligent Day Aggregation Service

Intelligently aggregates multiple meeting briefs into cohesive day narrative
Detects conflicts, overlaps, themes, and dependencies across meetings
"""

import json
from typing import Dict, List, Any
from app.services.gpt_service import call_gpt, safe_parse_json
from app.services.logger import logger


async def detect_cross_conflicts(briefs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Detect conflicts across meeting briefs
    Args:
        briefs: Array of meeting brief objects
    Returns:
        Detected conflicts
    """
    if not briefs or len(briefs) < 2:
        return []
    
    # Extract key statements from each brief
    brief_summaries = []
    for index, brief in enumerate(briefs):
        brief_summaries.append({
            'index': index,
            'meeting': brief.get('meeting', {}).get('summary') or brief.get('meeting', {}).get('title') or f'Meeting {index + 1}',
            'summary': brief.get('summary', ''),
            'narrative': brief.get('context', {}).get('broaderNarrative', ''),
            'actionItems': brief.get('context', {}).get('actionItems', []),
            'timeline': brief.get('context', {}).get('timeline', [])
        })
    
    analysis = await call_gpt([{
        'role': 'system',
        'content': """Analyze these meeting briefs for conflicts, contradictions, or inconsistencies.

Return JSON:
{
  "conflicts": [
    {
      "meetings": ["Meeting A", "Meeting B"],
      "type": "contradiction|inconsistency|competing_priority",
      "description": "What conflicts?",
      "severity": "high|medium|low"
    }
  ],
  "consistencies": ["What aligns across meetings?"]
}

Look for:
- Status conflicts ("on track" vs "blocked")
- Priority conflicts (multiple "top priorities")
- Decision conflicts (different decisions on same topic)
- Timeline conflicts (contradictory dates/milestones)
- Resource conflicts (same people needed in multiple places)"""
    }, {
        'role': 'user',
        'content': f"Meeting briefs:\n{json.dumps(brief_summaries, indent=2)}"
    }], 1500)
    
    try:
        result = safe_parse_json(analysis)
        if isinstance(result, dict):
            return result.get('conflicts', [])
        return []
    except Exception:
        return []


def detect_overlaps(briefs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Detect overlapping people and topics across meetings
    Args:
        briefs: Array of meeting brief objects
    Returns:
        Overlap analysis
    """
    person_meetings = {}  # person email -> meetings they're in
    topic_meetings = {}  # topic -> meetings discussing it
    
    for brief_index, brief in enumerate(briefs):
        meeting_title = brief.get('meeting', {}).get('summary') or brief.get('meeting', {}).get('title') or f'Meeting {brief_index + 1}'
        
        # Track people
        for att in brief.get('attendees', []):
            email = att.get('email') or att.get('emailAddress')
            if email:
                if email not in person_meetings:
                    person_meetings[email] = {
                        'name': att.get('name') or att.get('displayName') or email,
                        'meetings': [],
                        'contexts': []
                    }
                person_meetings[email]['meetings'].append(meeting_title)
                person_meetings[email]['contexts'].append(brief.get('context', {}))
        
        # Extract topics from summary/narrative
        text = f"{brief.get('summary', '')} {brief.get('context', {}).get('broaderNarrative', '')}".lower()
        topics = extract_topics(text)
        for topic in topics:
            if topic not in topic_meetings:
                topic_meetings[topic] = []
            topic_meetings[topic].append(meeting_title)
    
    # Find significant overlaps
    people_in_multiple = [
        {
            'email': email,
            'name': data['name'],
            'meetingCount': len(data['meetings']),
            'meetings': data['meetings'],
            'contexts': data['contexts']
        }
        for email, data in person_meetings.items()
        if len(data['meetings']) > 1
    ]
    people_in_multiple.sort(key=lambda x: x['meetingCount'], reverse=True)
    
    topics_in_multiple = [
        {
            'topic': topic,
            'meetingCount': len(meetings),
            'meetings': meetings
        }
        for topic, meetings in topic_meetings.items()
        if len(meetings) > 1
    ]
    topics_in_multiple.sort(key=lambda x: x['meetingCount'], reverse=True)
    
    return {
        'peopleOverlaps': people_in_multiple,
        'topicOverlaps': topics_in_multiple,
        'summary': {
            'peopleInMultiple': len(people_in_multiple),
            'topicsInMultiple': len(topics_in_multiple),
            'mostCommonPerson': people_in_multiple[0] if people_in_multiple else None,
            'mostCommonTopic': topics_in_multiple[0] if topics_in_multiple else None
        }
    }


def extract_topics(text: str) -> List[str]:
    """Extract key topics from text"""
    keywords = ['project', 'product', 'launch', 'roadmap', 'planning', 'review', 'update', 'design', 'engineering', 'sales', 'marketing', 'budget', 'hiring', 'strategy', 'partnership', 'customer', 'revenue', 'growth']
    
    found = set()
    for keyword in keywords:
        if keyword in text:
            found.add(keyword)
    
    return list(found)


async def detect_dependencies(meetings: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Detect meeting dependencies and suggest optimal sequencing
    Args:
        meetings: Array of meeting objects with briefs
    Returns:
        Dependency analysis
    """
    if not meetings or len(meetings) < 2:
        return {
            'dependencies': [],
            'suggestedOrder': meetings or [],
            'reasoning': 'Only one meeting or no meetings'
        }
    
    meeting_summaries = []
    for index, m in enumerate(meetings):
        meeting_summaries.append({
            'index': index,
            'title': m.get('meeting', {}).get('summary') or m.get('meeting', {}).get('title') or f'Meeting {index + 1}',
            'time': m.get('meeting', {}).get('start', {}).get('dateTime') or m.get('meeting', {}).get('start', {}).get('date'),
            'attendees': [a.get('name') or a.get('email') for a in (m.get('attendees') or [])],
            'topics': m.get('context', {}).get('broaderNarrative', '') or m.get('summary', ''),
            'actionItems': m.get('context', {}).get('actionItems', [])
        })
    
    analysis = await call_gpt([{
        'role': 'system',
        'content': """Analyze these meetings to identify dependencies and optimal sequence.

Return JSON:
{
  "dependencies": [
    {
      "meeting": "Meeting A",
      "dependsOn": "Meeting B",
      "reason": "Why does A depend on B?",
      "type": "decision|information|approval|preparation"
    }
  ],
  "suggestedOrder": ["Meeting B", "Meeting A", ...],
  "reasoning": "Why this order is optimal"
}

Consider:
- Information dependencies (need output from meeting X before meeting Y)
- Decision dependencies (decision in X affects Y)
- People dependencies (same key person in multiple meetings)
- Topic dependencies (meetings on related topics should be prepared together)
- Time dependencies (earlier meetings affect later ones)"""
    }, {
        'role': 'user',
        'content': f"Meetings:\n{json.dumps(meeting_summaries, indent=2)}"
    }], 1200)
    
    try:
        return safe_parse_json(analysis)
    except Exception:
        return {
            'dependencies': [],
            'suggestedOrder': meetings,
            'reasoning': 'Could not analyze dependencies'
        }


async def detect_themes(briefs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Detect thematic threads across meetings
    Args:
        briefs: Array of meeting briefs
    Returns:
        Thematic threads
    """
    if not briefs or len(briefs) < 2:
        return []
    
    meeting_contexts = []
    for index, brief in enumerate(briefs):
        meeting_contexts.append({
            'meeting': brief.get('meeting', {}).get('summary') or brief.get('meeting', {}).get('title') or f'Meeting {index + 1}',
            'context': brief.get('context', {}).get('broaderNarrative', '') or brief.get('summary', ''),
            'attendees': [a.get('name') for a in (brief.get('attendees') or [])],
            'actionItems': brief.get('context', {}).get('actionItems', [])
        })
    
    analysis = await call_gpt([{
        'role': 'system',
        'content': """Identify thematic threads connecting these meetings.

Return JSON array of themes:
[
  {
    "theme": "Theme name",
    "meetings": ["Meeting A", "Meeting B"],
    "description": "How are they connected?",
    "significance": "high|medium|low"
  }
]

Look for:
- Shared projects/initiatives
- Related topics
- Common people
- Sequential decision-making
- Connected action items"""
    }, {
        'role': 'user',
        'content': f"Meetings:\n{json.dumps(meeting_contexts, indent=2)}"
    }], 1000)
    
    try:
        themes = safe_parse_json(analysis)
        return themes if isinstance(themes, list) else []
    except Exception:
        return []


async def intelligently_aggregate(briefs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Intelligently aggregate meeting briefs into day context
    Args:
        briefs: Array of meeting briefs
    Returns:
        Aggregated, de-duplicated, intelligent day context
    """
    logger.info(f"\n  🧩 Intelligently aggregating {len(briefs)} meeting briefs...")
    
    # Detect overlaps
    overlaps = detect_overlaps(briefs)
    logger.info(f"  👥 Overlap detection: {len(overlaps['peopleOverlaps'])} people in multiple meetings, {len(overlaps['topicOverlaps'])} shared topics")
    
    # Detect conflicts
    conflicts = await detect_cross_conflicts(briefs)
    logger.info(f"  ⚠️  Conflict detection: {len(conflicts)} potential conflicts/inconsistencies")
    
    # Detect themes
    themes = await detect_themes(briefs)
    logger.info(f"  🎯 Theme detection: {len(themes)} thematic threads identified")
    
    # Detect dependencies
    dependencies = await detect_dependencies(briefs)
    logger.info(f"  🔗 Dependency analysis: {len(dependencies.get('dependencies', []))} dependencies found")
    
    # Build intelligent aggregation
    aggregated = {
        'keyPeople': [
            {
                'name': person['name'],
                'meetings': person['meetings'],
                'roleAcrossMeetings': f"Appears in {person['meetingCount']} meetings: {', '.join(person['meetings'])}"
            }
            for person in overlaps['peopleOverlaps'][:10]
        ],
        'themes': themes,
        'conflicts': conflicts,
        'dependencies': dependencies.get('dependencies', []),
        'suggestedMeetingOrder': dependencies.get('suggestedOrder', []),
        'emailAnalysis': deduplicate_context([b.get('context', {}).get('emailAnalysis') for b in briefs if b.get('context', {}).get('emailAnalysis')]),
        'documentAnalysis': deduplicate_context([b.get('context', {}).get('documentAnalysis') for b in briefs if b.get('context', {}).get('documentAnalysis')]),
        'relationshipAnalysis': deduplicate_context([b.get('context', {}).get('relationshipAnalysis') for b in briefs if b.get('context', {}).get('relationshipAnalysis')]),
        'timeline': merge_timelines([b.get('context', {}).get('timeline', []) for b in briefs]),
        'actionItems': deduplicate_action_items([item for b in briefs for item in (b.get('context', {}).get('actionItems', []))])
    }
    
    logger.info(f"  ✓ Aggregation complete: {len(aggregated['keyPeople'])} key people, {len(aggregated['themes'])} themes, {len(aggregated['conflicts'])} conflicts")
    
    return aggregated


def deduplicate_context(context_array: List[str]) -> str:
    """De-duplicate context strings by removing redundant information"""
    if not context_array or len(context_array) == 0:
        return ''
    if len(context_array) == 1:
        return context_array[0]
    
    # Simple de-duplication: join with separators
    return '\n\n---\n\n'.join(context_array)


def merge_timelines(timeline_arrays: List[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Merge timelines from multiple briefs"""
    all_events = []
    for timeline_array in timeline_arrays:
        all_events.extend(timeline_array)
    
    # De-duplicate by ID
    seen = set()
    unique = []
    for event in all_events:
        event_id = event.get('id')
        if event_id and event_id in seen:
            continue
        if event_id:
            seen.add(event_id)
        unique.append(event)
    
    # Sort by date (most recent first)
    unique.sort(key=lambda e: e.get('date') or e.get('start', {}).get('dateTime') or '', reverse=True)
    
    return unique[:50]  # Limit to 50 most relevant events


def deduplicate_action_items(action_items: List[str]) -> List[str]:
    """De-duplicate action items"""
    if not action_items or len(action_items) == 0:
        return []
    
    # Remove exact duplicates
    unique = list(set(action_items))
    
    # Remove similar items (simple string similarity)
    deduped = []
    for item in unique:
        is_similar = any(string_similarity(item.lower(), existing.lower()) > 0.7 for existing in deduped)
        if not is_similar:
            deduped.append(item)
    
    return deduped[:15]  # Limit to 15 most important


def string_similarity(str1: str, str2: str) -> float:
    """Simple string similarity (Jaccard similarity)"""
    set1 = set(str1.split())
    set2 = set(str2.split())
    
    intersection = set1 & set2
    union = set1 | set2
    
    return len(intersection) / len(union) if len(union) > 0 else 0.0

