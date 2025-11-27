/**
 * Intelligent Day Aggregation Service
 * 
 * Intelligently aggregates multiple meeting briefs into cohesive day narrative
 * Detects conflicts, overlaps, themes, and dependencies across meetings
 */

const { callGPT, safeParseJSON } = require('./gptService');

/**
 * Detect conflicts across meeting briefs
 * 
 * @param {Array} briefs - Array of meeting brief objects
 * @returns {Array} - Detected conflicts
 */
async function detectCrossConflicts(briefs) {
    if (!briefs || briefs.length < 2) {
        return [];
    }
    
    // Extract key statements from each brief
    const briefSummaries = briefs.map((brief, index) => ({
        index,
        meeting: brief.meeting?.summary || brief.meeting?.title || `Meeting ${index + 1}`,
        summary: brief.summary || '',
        narrative: brief.context?.broaderNarrative || '',
        actionItems: brief.context?.actionItems || [],
        timeline: brief.context?.timeline || []
    }));
    
    const analysis = await callGPT([{
        role: 'system',
        content: `Analyze these meeting briefs for conflicts, contradictions, or inconsistencies.

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
- Resource conflicts (same people needed in multiple places)`
    }, {
        role: 'user',
        content: `Meeting briefs:\n${JSON.stringify(briefSummaries, null, 2)}`
    }], 1500);
    
    try {
        const result = safeParseJSON(analysis);
        return result.conflicts || [];
    } catch (e) {
        return [];
    }
}

/**
 * Detect overlapping people and topics across meetings
 * 
 * @param {Array} briefs - Array of meeting brief objects
 * @returns {Object} - Overlap analysis
 */
function detectOverlaps(briefs) {
    const personMeetings = new Map(); // person email -> meetings they're in
    const topicMeetings = new Map();  // topic -> meetings discussing it
    
    briefs.forEach((brief, briefIndex) => {
        const meetingTitle = brief.meeting?.summary || brief.meeting?.title || `Meeting ${briefIndex + 1}`;
        
        // Track people
        (brief.attendees || []).forEach(att => {
            const email = att.email || att.emailAddress;
            if (email) {
                if (!personMeetings.has(email)) {
                    personMeetings.set(email, {
                        name: att.name || att.displayName || email,
                        meetings: [],
                        contexts: []
                    });
                }
                personMeetings.get(email).meetings.push(meetingTitle);
                personMeetings.get(email).contexts.push(brief.context || {});
            }
        });
        
        // Extract topics from summary/narrative
        const text = `${brief.summary || ''} ${brief.context?.broaderNarrative || ''}`.toLowerCase();
        const topics = extractTopics(text);
        topics.forEach(topic => {
            if (!topicMeetings.has(topic)) {
                topicMeetings.set(topic, []);
            }
            topicMeetings.get(topic).push(meetingTitle);
        });
    });
    
    // Find significant overlaps
    const peopleInMultipleMeetings = Array.from(personMeetings.entries())
        .filter(([_, data]) => data.meetings.length > 1)
        .map(([email, data]) => ({
            email,
            name: data.name,
            meetingCount: data.meetings.length,
            meetings: data.meetings,
            contexts: data.contexts
        }))
        .sort((a, b) => b.meetingCount - a.meetingCount);
    
    const topicsInMultipleMeetings = Array.from(topicMeetings.entries())
        .filter(([_, meetings]) => meetings.length > 1)
        .map(([topic, meetings]) => ({
            topic,
            meetingCount: meetings.length,
            meetings
        }))
        .sort((a, b) => b.meetingCount - a.meetingCount);
    
    return {
        peopleOverlaps: peopleInMultipleMeetings,
        topicOverlaps: topicsInMultipleMeetings,
        summary: {
            peopleInMultiple: peopleInMultipleMeetings.length,
            topicsInMultiple: topicsInMultipleMeetings.length,
            mostCommonPerson: peopleInMultipleMeetings[0] || null,
            mostCommonTopic: topicsInMultipleMeetings[0] || null
        }
    };
}

/**
 * Extract key topics from text
 */
function extractTopics(text) {
    const keywords = ['project', 'product', 'launch', 'roadmap', 'planning', 'review', 'update', 'design', 'engineering', 'sales', 'marketing', 'budget', 'hiring', 'strategy', 'partnership', 'customer', 'revenue', 'growth'];
    
    const found = new Set();
    keywords.forEach(keyword => {
        if (text.includes(keyword)) {
            found.add(keyword);
        }
    });
    
    return Array.from(found);
}

/**
 * Detect meeting dependencies and suggest optimal sequencing
 * 
 * @param {Array} meetings - Array of meeting objects with briefs
 * @returns {Object} - Dependency analysis
 */
async function detectDependencies(meetings) {
    if (!meetings || meetings.length < 2) {
        return {
            dependencies: [],
            suggestedOrder: meetings || [],
            reasoning: 'Only one meeting or no meetings'
        };
    }
    
    const meetingSummaries = meetings.map((m, index) => ({
        index,
        title: m.meeting?.summary || m.meeting?.title || `Meeting ${index + 1}`,
        time: m.meeting?.start?.dateTime || m.meeting?.start?.date,
        attendees: (m.attendees || []).map(a => a.name || a.email),
        topics: m.context?.broaderNarrative || m.summary || '',
        actionItems: m.context?.actionItems || []
    }));
    
    const analysis = await callGPT([{
        role: 'system',
        content: `Analyze these meetings to identify dependencies and optimal sequence.

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
- Time dependencies (earlier meetings affect later ones)`
    }, {
        role: 'user',
        content: `Meetings:\n${JSON.stringify(meetingSummaries, null, 2)}`
    }], 1200);
    
    try {
        return safeParseJSON(analysis);
    } catch (e) {
        return {
            dependencies: [],
            suggestedOrder: meetings,
            reasoning: 'Could not analyze dependencies'
        };
    }
}

/**
 * Detect thematic threads across meetings
 * 
 * @param {Array} briefs - Array of meeting briefs
 * @returns {Array} - Thematic threads
 */
async function detectThemes(briefs) {
    if (!briefs || briefs.length < 2) {
        return [];
    }
    
    const meetingContexts = briefs.map((brief, index) => ({
        meeting: brief.meeting?.summary || brief.meeting?.title || `Meeting ${index + 1}`,
        context: brief.context?.broaderNarrative || brief.summary || '',
        attendees: (brief.attendees || []).map(a => a.name),
        actionItems: brief.context?.actionItems || []
    }));
    
    const analysis = await callGPT([{
        role: 'system',
        content: `Identify thematic threads connecting these meetings.

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
- Connected action items`
    }, {
        role: 'user',
        content: `Meetings:\n${JSON.stringify(meetingContexts, null, 2)}`
    }], 1000);
    
    try {
        const themes = safeParseJSON(analysis);
        return Array.isArray(themes) ? themes : [];
    } catch (e) {
        return [];
    }
}

/**
 * Intelligently aggregate meeting briefs into day context
 * 
 * @param {Array} briefs - Array of meeting briefs
 * @returns {Object} - Aggregated, de-duplicated, intelligent day context
 */
async function intelligentlyAggregate(briefs) {
    console.log(`\n  🧩 Intelligently aggregating ${briefs.length} meeting briefs...`);
    
    // Detect overlaps
    const overlaps = detectOverlaps(briefs);
    console.log(`  👥 Overlap detection: ${overlaps.peopleOverlaps.length} people in multiple meetings, ${overlaps.topicOverlaps.length} shared topics`);
    
    // Detect conflicts
    const conflicts = await detectCrossConflicts(briefs);
    console.log(`  ⚠️  Conflict detection: ${conflicts.length} potential conflicts/inconsistencies`);
    
    // Detect themes
    const themes = await detectThemes(briefs);
    console.log(`  🎯 Theme detection: ${themes.length} thematic threads identified`);
    
    // Detect dependencies
    const dependencies = await detectDependencies(briefs);
    console.log(`  🔗 Dependency analysis: ${dependencies.dependencies?.length || 0} dependencies found`);
    
    // Build intelligent aggregation (not just concatenation)
    const aggregated = {
        // People who appear in multiple meetings (mention once with full context)
        keyPeople: overlaps.peopleOverlaps.slice(0, 10).map(person => ({
            name: person.name,
            meetings: person.meetings,
            roleAcrossMeetings: `Appears in ${person.meetingCount} meetings: ${person.meetings.join(', ')}`
        })),
        
        // Common themes across the day
        themes: themes,
        
        // Conflicts that need attention
        conflicts: conflicts,
        
        // Dependencies for optimal sequencing
        dependencies: dependencies.dependencies || [],
        suggestedMeetingOrder: dependencies.suggestedOrder || [],
        
        // Aggregated context (de-duplicated)
        emailAnalysis: deduplicateContext(briefs.map(b => b.context?.emailAnalysis).filter(Boolean)),
        documentAnalysis: deduplicateContext(briefs.map(b => b.context?.documentAnalysis).filter(Boolean)),
        relationshipAnalysis: deduplicateContext(briefs.map(b => b.context?.relationshipAnalysis).filter(Boolean)),
        
        // Timeline aggregated (sorted, de-duplicated)
        timeline: mergeTimelines(briefs.map(b => b.context?.timeline || [])),
        
        // Action items across all meetings
        actionItems: deduplicateActionItems(briefs.flatMap(b => b.context?.actionItems || []))
    };
    
    console.log(`  ✓ Aggregation complete: ${aggregated.keyPeople.length} key people, ${aggregated.themes.length} themes, ${aggregated.conflicts.length} conflicts`);
    
    return aggregated;
}

/**
 * De-duplicate context strings by removing redundant information
 */
function deduplicateContext(contextArray) {
    if (!contextArray || contextArray.length === 0) return '';
    if (contextArray.length === 1) return contextArray[0];
    
    // Simple de-duplication: join with separators and let LLM synthesis handle it
    // More sophisticated approach would use similarity detection
    return contextArray.join('\n\n---\n\n');
}

/**
 * Merge timelines from multiple briefs
 */
function mergeTimelines(timelineArrays) {
    const allEvents = timelineArrays.flat();
    
    // De-duplicate by ID
    const seen = new Set();
    const unique = allEvents.filter(event => {
        if (seen.has(event.id)) return false;
        seen.add(event.id);
        return true;
    });
    
    // Sort by date
    unique.sort((a, b) => {
        const dateA = new Date(a.date || a.start?.dateTime);
        const dateB = new Date(b.date || b.start?.dateTime);
        return dateB - dateA; // Most recent first
    });
    
    return unique.slice(0, 50); // Limit to 50 most relevant events
}

/**
 * De-duplicate action items
 */
function deduplicateActionItems(actionItems) {
    if (!actionItems || actionItems.length === 0) return [];
    
    // Remove exact duplicates
    const unique = [...new Set(actionItems)];
    
    // Remove similar items (simple string similarity)
    const deduped = [];
    unique.forEach(item => {
        const isSimilar = deduped.some(existing => {
            const similarity = stringSimilarity(item.toLowerCase(), existing.toLowerCase());
            return similarity > 0.7;
        });
        
        if (!isSimilar) {
            deduped.push(item);
        }
    });
    
    return deduped.slice(0, 15); // Limit to 15 most important
}

/**
 * Simple string similarity (Jaccard similarity)
 */
function stringSimilarity(str1, str2) {
    const set1 = new Set(str1.split(' '));
    const set2 = new Set(str2.split(' '));
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
}

module.exports = {
    detectCrossConflicts,
    detectOverlaps,
    detectDependencies,
    detectThemes,
    intelligentlyAggregate
};

