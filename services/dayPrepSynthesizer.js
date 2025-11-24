/**
 * Day Prep Synthesizer
 *
 * Synthesizes multiple meeting briefs into a comprehensive day prep using Shadow persona
 */

const { callGPT } = require('./gptService');
const logger = require('./logger');
const { getUserContext } = require('./userContext');

/**
 * Synthesize day prep from multiple meeting briefs
 * 
 * @param {Date} selectedDate - The date for day prep
 * @param {Array} meetings - Array of meeting objects
 * @param {Array} briefs - Array of meeting brief objects
 * @param {string} requestId - Request ID for logging
 * @param {Object} req - Express request object (optional, for user context)
 * @returns {Promise<Object>} Day prep object with narrative and structure
 */
async function synthesizeDayPrep(selectedDate, meetings, briefs, requestId, req = null) {
    try {
        logger.info({ requestId, meetingCount: meetings.length, briefCount: briefs.length }, 'Synthesizing day prep');

        // Format date - use the date as-is (already in local timezone from dayPrep.js)
        // Format using local timezone to match user's calendar
        const dateStr = selectedDate.toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric'
            // No timeZone specified - uses local timezone
        });

        // Group meetings by time blocks
        const morningMeetings = [];
        const middayMeetings = [];
        const afternoonMeetings = [];

        meetings.forEach((meeting, index) => {
            const startTime = meeting.start?.dateTime || meeting.start?.date || meeting.start;
            if (!startTime) return;

            const hour = new Date(startTime).getHours();
            const brief = briefs[index] || null;

            const meetingInfo = {
                title: meeting.summary || meeting.title || 'Untitled Meeting',
                time: new Date(startTime).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                }),
                attendees: meeting.attendees || [],
                brief: brief
            };

            if (hour < 12) {
                morningMeetings.push(meetingInfo);
            } else if (hour < 17) {
                middayMeetings.push(meetingInfo);
            } else {
                afternoonMeetings.push(meetingInfo);
            }
        });

        // Build comprehensive context for Shadow persona with FULL meeting brief data
        const meetingContext = meetings.map((meeting, index) => {
            const brief = briefs[index];
            const startTime = meeting.start?.dateTime || meeting.start?.date || meeting.start;
            
            // Extract full attendee details with keyFacts from brief
            const briefAttendees = brief?.attendees || [];
            const meetingAttendees = meeting.attendees || [];
            
            // Merge attendees: prefer brief attendees (with keyFacts), fallback to meeting attendees
            const allAttendees = briefAttendees.length > 0 ? briefAttendees : meetingAttendees.map(a => ({
                name: a.displayName || a.email || 'Unknown',
                email: a.email || a.emailAddress,
                company: a.company || (a.email ? a.email.split('@')[1] : 'Unknown'),
                title: a.title || '',
                keyFacts: []
            }));
            
            return {
                title: meeting.summary || meeting.title || 'Untitled Meeting',
                time: startTime ? new Date(startTime).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                }) : 'Time TBD',
                attendees: allAttendees.map(a => ({
                    name: a.name || a.displayName || a.email || 'Unknown',
                    email: a.email || a.emailAddress,
                    company: a.company || (a.email ? a.email.split('@')[1] : 'Unknown'),
                    title: a.title || '',
                    keyFacts: a.keyFacts || []
                })),
                // Include ALL brief fields
                summary: brief?.summary || '',
                relationshipAnalysis: brief?.relationshipAnalysis || '',
                emailAnalysis: brief?.emailAnalysis || '',
                documentAnalysis: brief?.documentAnalysis || '',
                companyResearch: brief?.companyResearch || '',
                contributionAnalysis: brief?.contributionAnalysis || '',
                broaderNarrative: brief?.broaderNarrative || '',
                recommendations: brief?.recommendations || [],
                actionItems: brief?.actionItems || [],
                timeline: brief?.timeline || [],
                keyPoints: brief?.actionItems?.slice(0, 5) || [], // Increased from 3 to 5
                context: brief?.context || ''
            };
        }).filter(m => m.title !== 'Untitled Meeting' || m.summary);
        
        // Aggregate all unique attendees across all meetings with their keyFacts
        const attendeeMap = new Map();
        meetingContext.forEach(m => {
            m.attendees.forEach(att => {
                const email = (att.email || '').toLowerCase();
                if (email && !attendeeMap.has(email)) {
                    attendeeMap.set(email, {
                        name: att.name,
                        email: att.email,
                        company: att.company,
                        title: att.title,
                        keyFacts: att.keyFacts || []
                    });
                } else if (email && attendeeMap.has(email)) {
                    // Merge keyFacts if attendee appears in multiple meetings
                    const existing = attendeeMap.get(email);
                    const newFacts = att.keyFacts || [];
                    existing.keyFacts = [...new Set([...existing.keyFacts, ...newFacts])];
                }
            });
        });
        const aggregatedAttendees = Array.from(attendeeMap.values());
        
        // Extract all attendee names for transcription hints
        const allAttendeeNames = aggregatedAttendees
            .map(a => {
                const name = a.name || '';
                const parts = name.split(' ');
                return [name, parts[0], parts[parts.length - 1]].filter(Boolean);
            })
            .flat()
            .filter((name, index, self) => self.indexOf(name) === index); // Remove duplicates
        
        // Aggregate context across all meetings
        const aggregatedContext = {
            relationshipAnalysis: meetingContext.map(m => m.relationshipAnalysis).filter(Boolean).join('\n\n'),
            emailAnalysis: meetingContext.map(m => m.emailAnalysis).filter(Boolean).join('\n\n'),
            documentAnalysis: meetingContext.map(m => m.documentAnalysis).filter(Boolean).join('\n\n'),
            companyResearch: meetingContext.map(m => m.companyResearch).filter(Boolean).join('\n\n'),
            contributionAnalysis: meetingContext.map(m => m.contributionAnalysis).filter(Boolean).join('\n\n'),
            broaderNarrative: meetingContext.map(m => m.broaderNarrative).filter(Boolean).join('\n\n'),
            recommendations: [...new Set(meetingContext.flatMap(m => m.recommendations || []))],
            actionItems: [...new Set(meetingContext.flatMap(m => m.actionItems || []))],
            timeline: meetingContext.flatMap(m => m.timeline || [])
        };

        // Get user context
        const userContext = req ? await getUserContext(req) : null;
        const userName = userContext ? userContext.formattedName : 'the user';
        const userEmail = userContext ? userContext.formattedEmail : '';
        
        // Generate dynamic prompt structure using GPT (like meeting prep)
        const fetch = require('node-fetch');
        const openaiApiKey = process.env.OPENAI_API_KEY;
        
        let promptStructure;
        try {
            const systemPromptForGPT = `You are an expert at creating system prompts for voice AI assistants. Generate a comprehensive, well-structured system prompt framework for Shadow's day prep mode.

The prompt structure should:
1. Include transcription hints section (with placeholder for attendee names)
2. Include Shadow's role and persona for day prep
3. Include briefing instructions (5-7 minutes, 750-1000 words, concise, Shadow's style)
4. Include interruption handling rules
5. Include response format requirements
6. Be well-structured and comprehensive

Format: Return ONLY the system prompt structure text with placeholders like [ATTENDEE_NAMES], [DATE], [USER_NAME], etc. No markdown, no explanations.`;

            const userPromptForGPT = `Generate a system prompt structure for Shadow's day prep mode briefing ${userName} about their day.

DAY OVERVIEW:
- Date: [DATE]
- Meeting Count: ${meetingContext.length}
- Attendee Count: ${aggregatedAttendees.length}
- Companies: ${[...new Set(aggregatedAttendees.map(a => a.company).filter(Boolean))].join(', ') || 'Various'}

The structure should include placeholders for:
- [ATTENDEE_NAMES] - list of all attendee names for transcription hints
- [DATE] - the date string
- [USER_NAME] - user's name
- [USER_EMAIL] - user's email
- [MEETING_CONTEXT_SECTION] - comprehensive meeting context section
- [AGGREGATED_CONTEXT_SECTION] - aggregated context from all meetings

Generate a comprehensive system prompt structure for Shadow's day prep mode.`;

            const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: [
                        { role: 'system', content: systemPromptForGPT },
                        { role: 'user', content: userPromptForGPT }
                    ],
                    temperature: 0.7,
                    max_tokens: 1500
                })
            });

            if (gptResponse.ok) {
                const gptData = await gptResponse.json();
                promptStructure = gptData.choices[0].message.content.trim();
                logger.info({ requestId }, 'Generated dynamic day prep prompt structure using GPT');
            } else {
                throw new Error(`GPT API error: ${gptResponse.status}`);
            }
        } catch (error) {
            logger.warn({ requestId, error: error.message }, 'Failed to generate dynamic prompt structure, using fallback');
            promptStructure = null; // Will use fallback prompt
        }
        
        // Build comprehensive meeting context section
        const meetingContextSection = meetingContext.map((m, i) => `
Meeting ${i + 1}: ${m.title}
Time: ${m.time}
Attendees: ${m.attendees.map(a => `${a.name}${a.company ? ` (${a.company})` : ''}${a.title ? ` - ${a.title}` : ''}`).join(', ')}
${m.summary ? `Summary: ${m.summary}` : ''}
${m.keyPoints.length > 0 ? `Key Action Items: ${m.keyPoints.join('; ')}` : ''}
${m.relationshipAnalysis ? `Relationship Context: ${m.relationshipAnalysis.substring(0, 400)}` : ''}
${m.emailAnalysis ? `Email Context: ${m.emailAnalysis.substring(0, 400)}` : ''}
${m.documentAnalysis ? `Document Context: ${m.documentAnalysis.substring(0, 400)}` : ''}
${m.companyResearch ? `Company Research: ${m.companyResearch.substring(0, 400)}` : ''}
${m.recommendations.length > 0 ? `Recommendations: ${m.recommendations.join('; ')}` : ''}
`).join('\n---\n');
        
        // Build aggregated context section
        const aggregatedContextSection = `
AGGREGATED CONTEXT ACROSS ALL MEETINGS:

Relationship Analysis:
${aggregatedContext.relationshipAnalysis || 'No relationship analysis available.'}

Email Context:
${aggregatedContext.emailAnalysis || 'No email context available.'}

Document Context:
${aggregatedContext.documentAnalysis || 'No document context available.'}

Company Research:
${aggregatedContext.companyResearch || 'No company research available.'}

Contribution Analysis:
${aggregatedContext.contributionAnalysis || 'No contribution analysis available.'}

Broader Narrative:
${aggregatedContext.broaderNarrative || 'No broader narrative available.'}

Recommendations:
${aggregatedContext.recommendations.length > 0 ? aggregatedContext.recommendations.join('\n• ') : 'None provided.'}

Action Items:
${aggregatedContext.actionItems.length > 0 ? aggregatedContext.actionItems.join('\n• ') : 'None provided.'}

Timeline Events:
${aggregatedContext.timeline.length > 0 ? aggregatedContext.timeline.slice(0, 10).map((event, idx) => {
    const date = event.date || event.start?.dateTime || 'Date unknown';
    const type = event.type || 'event';
    const title = event.title || event.summary || 'Untitled';
    return `${idx + 1}. [${date}] ${type}: ${title}`;
}).join('\n') : 'No timeline events available.'}
`;
        
        // Build transcription hints
        const transcriptionHints = allAttendeeNames.length > 0
            ? `\n\nTRANSCRIPTION ACCURACY HINTS:\nWhen transcribing user speech, pay special attention to these names: ${allAttendeeNames.join(', ')}. These are meeting attendees and should be transcribed accurately.\n`
            : '';
        
        // Use dynamic prompt structure or fallback
        const shadowPrompt = promptStructure
            ? promptStructure
                .replace(/\[ATTENDEE_NAMES\]/g, allAttendeeNames.join(', '))
                .replace(/\[DATE\]/g, dateStr)
                .replace(/\[USER_NAME\]/g, userName)
                .replace(/\[USER_EMAIL\]/g, userEmail)
                .replace(/\[MEETING_CONTEXT_SECTION\]/g, meetingContextSection)
                .replace(/\[AGGREGATED_CONTEXT_SECTION\]/g, aggregatedContextSection)
                + transcriptionHints
            : `You are Shadow, ${userName}'s personalized, hyper-contextual, ultra-efficient executive assistant that helps prepare for meetings.

${userContext ? `IMPORTANT: You are preparing ${userName} (${userEmail}) for their day. Use "you" to refer to ${userName}. Structure everything from ${userName}'s perspective.` : ''}

Your job in this mode is to prepare ${userName} for their entire day with a clear, crisp, strategic start-of-day voice brief.

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

Today is ${dateStr}.${transcriptionHints}

MEETINGS FOR TODAY:
${meetingContextSection}

AGGREGATED CONTEXT:
${aggregatedContextSection}

Generate the day prep brief now. Speak naturally, as if you're briefing ${userName} while ${userContext ? 'they' : 'the user'} are getting ready for ${userContext ? 'their' : 'the'} day. Use "you" consistently to refer to ${userName}.`;

        const response = await callGPT([
            {
                role: 'system',
                content: shadowPrompt
            }
        ], {
            model: 'gpt-4o',
            temperature: 0.7,
            max_tokens: 3500 // Increased from 2000 to 3000-4000 range
        });

        const narrative = response.content || response.text || '';

        logger.info({ requestId, narrativeLength: narrative.length }, 'Day prep synthesized');

        return {
            summary: `Day prep for ${dateStr}`,
            narrative: narrative,
            structure: {
                orientation: extractSection(narrative, 'Orientation', 'Morning'),
                morning: extractSection(narrative, 'Morning', 'Midday'),
                midday: extractSection(narrative, 'Midday', 'Afternoon'),
                afternoon: extractSection(narrative, 'Afternoon', 'Win'),
                winCondition: extractSection(narrative, 'Win', 'Optional')
            },
            // Return FULL meeting briefs, not just summaries
            meetings: briefs.filter(b => b !== null && b !== undefined), // Full brief objects
            // Return aggregated attendees with keyFacts
            aggregatedAttendees: aggregatedAttendees,
            // Return aggregated context
            aggregatedContext: aggregatedContext,
            // Return date for voice prep detection
            date: dateStr,
            // Return all attendee names for transcription hints
            attendeeNames: allAttendeeNames
        };

    } catch (error) {
        logger.error({ requestId, error: error.message, stack: error.stack }, 'Error synthesizing day prep');
        
        // Fallback: Simple summary
        const fallbackDateStr = new Date(Date.UTC(
            selectedDate.getFullYear(),
            selectedDate.getMonth(),
            selectedDate.getDate()
        )).toLocaleDateString('en-US', { 
            weekday: 'long', 
            month: 'long', 
            day: 'numeric',
            timeZone: 'UTC'
        });
        
        return {
            summary: `Day prep for ${fallbackDateStr}`,
            narrative: `You have ${meetings.length} meeting${meetings.length !== 1 ? 's' : ''} scheduled for today. ${briefs.length > 0 ? 'Meeting briefs have been prepared.' : 'Preparing meeting briefs...'}`,
            structure: {
                orientation: '',
                morning: '',
                midday: '',
                afternoon: '',
                winCondition: ''
            },
            // Return FULL meeting briefs even in fallback
            meetings: briefs.filter(b => b !== null && b !== undefined),
            aggregatedAttendees: [],
            aggregatedContext: {
                relationshipAnalysis: '',
                emailAnalysis: '',
                documentAnalysis: '',
                companyResearch: '',
                contributionAnalysis: '',
                broaderNarrative: '',
                recommendations: [],
                actionItems: [],
                timeline: []
            },
            date: fallbackDateStr,
            attendeeNames: []
        };
    }
}

/**
 * Extract a section from narrative text
 */
function extractSection(text, startMarker, endMarker) {
    const startIdx = text.toLowerCase().indexOf(startMarker.toLowerCase());
    if (startIdx === -1) return '';

    const endIdx = text.toLowerCase().indexOf(endMarker.toLowerCase(), startIdx + startMarker.length);
    if (endIdx === -1) {
        return text.substring(startIdx).trim();
    }

    return text.substring(startIdx, endIdx).trim();
}

module.exports = {
    synthesizeDayPrep
};

