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

        // Build context for Shadow persona
        const meetingContext = meetings.map((meeting, index) => {
            const brief = briefs[index];
            const startTime = meeting.start?.dateTime || meeting.start?.date || meeting.start;
            return {
                title: meeting.summary || meeting.title || 'Untitled Meeting',
                time: startTime ? new Date(startTime).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                }) : 'Time TBD',
                attendees: (meeting.attendees || []).map(a => ({
                    name: a.displayName || a.email || 'Unknown',
                    email: a.email || a.emailAddress,
                    company: a.email ? a.email.split('@')[1] : 'Unknown'
                })),
                summary: brief?.summary || '',
                keyPoints: brief?.actionItems?.slice(0, 3) || [],
                context: brief?.context || ''
            };
        }).filter(m => m.title !== 'Untitled Meeting' || m.summary);

        // Get user context
        const userContext = req ? await getUserContext(req) : null;
        const userName = userContext ? userContext.formattedName : 'the user';
        const userEmail = userContext ? userContext.formattedEmail : '';
        
        // Call GPT with Shadow persona prompt
        const shadowPrompt = `You are Shadow, ${userName}'s personalized, hyper-contextual, ultra-efficient executive assistant that helps prepare for meetings.

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

Today is ${dateStr}.

Meetings for today:
${meetingContext.map((m, i) => `
Meeting ${i + 1}: ${m.title}
Time: ${m.time}
Attendees: ${m.attendees.map(a => `${a.name}${a.company ? ` (${a.company})` : ''}`).join(', ')}
${m.summary ? `Summary: ${m.summary.substring(0, 300)}` : ''}
${m.keyPoints.length > 0 ? `Key Points: ${m.keyPoints.join('; ')}` : ''}
${m.context ? `Context: ${m.context.substring(0, 500)}` : ''}
`).join('\n---\n')}

Generate the day prep brief now. Speak naturally, as if you're briefing ${userName} while ${userContext ? 'they' : 'the user'} are getting ready for ${userContext ? 'their' : 'the'} day. Use "you" consistently to refer to ${userName}.`;

        const response = await callGPT([
            {
                role: 'system',
                content: shadowPrompt
            }
        ], {
            model: 'gpt-4o',
            temperature: 0.7,
            max_tokens: 2000
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
            meetings: meetingContext.map(m => ({
                title: m.title,
                time: m.time,
                attendeeCount: m.attendees.length
            }))
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
            meetings: meetings.map(m => ({
                title: m.summary || m.title || 'Untitled Meeting',
                time: m.start?.dateTime || m.start?.date || 'Time TBD',
                attendeeCount: (m.attendees || []).length
            }))
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

