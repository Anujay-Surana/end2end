/**
 * User Profiling Service
 * 
 * Builds deep user profiles from communication patterns, expertise signals,
 * and behavioral patterns to personalize briefings
 */

const { callGPT, safeParseJSON } = require('./gptService');

/**
 * Analyze user's communication style from email history
 * 
 * @param {Array} userEmails - Emails sent by the user
 * @returns {Object} - Communication style profile
 */
async function analyzeCommunicationStyle(userEmails) {
    if (!userEmails || userEmails.length < 5) {
        return {
            style: 'unknown',
            formality: 'neutral',
            verbosity: 'moderate',
            confidence: 'low',
            characteristics: []
        };
    }
    
    // Sample up to 20 emails for analysis
    const sampleEmails = userEmails.slice(0, 20).map(e => ({
        subject: e.subject,
        bodyPreview: (e.body || e.snippet || '').substring(0, 1000),
        to: e.to,
        hasAttachments: e.attachments && e.attachments.length > 0
    }));
    
    const analysis = await callGPT([{
        role: 'system',
        content: `Analyze this user's communication style from their email patterns.

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
- Signature phrases or patterns`
    }, {
        role: 'user',
        content: `User's emails:\n${JSON.stringify(sampleEmails, null, 2)}`
    }], 800);
    
    try {
        const profile = safeParseJSON(analysis);
        return {
            ...profile,
            confidence: userEmails.length >= 20 ? 'high' : (userEmails.length >= 10 ? 'medium' : 'low'),
            sampleSize: userEmails.length
        };
    } catch (e) {
        return {
            style: 'unknown',
            formality: 'neutral',
            verbosity: 'moderate',
            confidence: 'low',
            characteristics: []
        };
    }
}

/**
 * Infer user's domain expertise from email vocabulary and topics
 * 
 * @param {Array} userEmails - Emails sent by the user
 * @param {Array} userDocuments - Documents created/modified by user
 * @returns {Object} - Expertise profile
 */
async function inferExpertise(userEmails, userDocuments = []) {
    if ((!userEmails || userEmails.length < 3) && (!userDocuments || userDocuments.length < 2)) {
        return {
            domains: [],
            level: 'unknown',
            confidence: 'low'
        };
    }
    
    // Extract vocabulary and topics from user content
    const userContent = [];
    
    if (userEmails && userEmails.length > 0) {
        userEmails.slice(0, 30).forEach(e => {
            userContent.push({
                type: 'email',
                subject: e.subject,
                content: (e.body || e.snippet || '').substring(0, 2000)
            });
        });
    }
    
    if (userDocuments && userDocuments.length > 0) {
        userDocuments.slice(0, 10).forEach(d => {
            userContent.push({
                type: 'document',
                name: d.name,
                content: (d.content || '').substring(0, 3000)
            });
        });
    }
    
    const analysis = await callGPT([{
        role: 'system',
        content: `Analyze this user's domain expertise based on their communication content.

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
- Teaching/explaining behaviors`
    }, {
        role: 'user',
        content: `User content samples:\n${JSON.stringify(userContent, null, 2)}`
    }], 1000);
    
    try {
        const expertise = safeParseJSON(analysis);
        return {
            ...expertise,
            confidence: userContent.length >= 15 ? 'high' : (userContent.length >= 5 ? 'medium' : 'low'),
            sampleSize: userContent.length
        };
    } catch (e) {
        return {
            domains: [],
            level: 'unknown',
            confidence: 'low'
        };
    }
}

/**
 * Analyze relationship strength from communication frequency and tone
 * 
 * @param {string} userEmail - User's email address
 * @param {string} otherEmail - Other person's email
 * @param {Array} allEmails - All emails in context
 * @returns {Object} - Relationship strength analysis
 */
function analyzeRelationshipStrength(userEmail, otherEmail, allEmails) {
    if (!allEmails || allEmails.length === 0) {
        return {
            strength: 'unknown',
            frequency: 0,
            recency: null,
            duration: null
        };
    }
    
    const userLower = userEmail.toLowerCase();
    const otherLower = otherEmail.toLowerCase();
    
    // Find emails between these two people
    const directEmails = allEmails.filter(e => {
        const from = (e.from || '').toLowerCase();
        const to = (e.to || '').toLowerCase();
        return (from.includes(userLower) && to.includes(otherLower)) ||
               (from.includes(otherLower) && to.includes(userLower));
    });
    
    if (directEmails.length === 0) {
        return {
            strength: 'unknown',
            frequency: 0,
            recency: null,
            duration: null
        };
    }
    
    // Calculate metrics
    const emailDates = directEmails
        .map(e => new Date(e.date))
        .filter(d => !isNaN(d.getTime()))
        .sort((a, b) => a - b);
    
    const mostRecent = emailDates[emailDates.length - 1];
    const oldest = emailDates[0];
    const daysSinceFirst = oldest ? (Date.now() - oldest.getTime()) / (1000 * 60 * 60 * 24) : 0;
    const daysSinceLast = mostRecent ? (Date.now() - mostRecent.getTime()) / (1000 * 60 * 60 * 24) : 0;
    
    // Determine strength
    let strength;
    const frequency = directEmails.length;
    const recencyDays = daysSinceLast;
    
    if (frequency >= 50 && recencyDays < 30) {
        strength = 'very_strong'; // Frequent, recent collaboration
    } else if (frequency >= 20 && recencyDays < 90) {
        strength = 'strong';
    } else if (frequency >= 10 && recencyDays < 180) {
        strength = 'moderate';
    } else if (frequency >= 5) {
        strength = 'weak';
    } else {
        strength = 'minimal';
    }
    
    return {
        strength,
        frequency,
        recency: mostRecent,
        daysSinceLast: Math.round(daysSinceLast),
        duration: Math.round(daysSinceFirst),
        firstContact: oldest,
        emailCount: frequency
    };
}

/**
 * Build comprehensive user profile from available data
 * 
 * @param {Object} user - User object with basic info
 * @param {Array} allEmails - All emails (user's and others')
 * @param {Array} allDocuments - All documents
 * @param {Array} calendarEvents - User's calendar events
 * @returns {Object} - Comprehensive user profile
 */
async function buildUserProfile(user, allEmails = [], allDocuments = [], calendarEvents = []) {
    const profile = {
        userId: user.id,
        email: user.email,
        name: user.name,
        communicationStyle: null,
        expertise: null,
        workingPatterns: null,
        relationships: []
    };
    
    // Extract user's sent emails
    const userSentEmails = allEmails.filter(e => {
        const from = (e.from || '').toLowerCase();
        return from.includes(user.email.toLowerCase());
    });
    
    // Extract user's documents
    const userDocuments = allDocuments.filter(d => {
        const owner = (d.ownerEmail || d.owner || '').toLowerCase();
        return owner.includes(user.email.toLowerCase());
    });
    
    // Analyze communication style if enough data
    if (userSentEmails.length >= 5) {
        console.log(`  👤 Analyzing ${user.name}'s communication style from ${userSentEmails.length} emails...`);
        profile.communicationStyle = await analyzeCommunicationStyle(userSentEmails);
    }
    
    // Infer expertise if enough data
    if (userSentEmails.length >= 3 || userDocuments.length >= 2) {
        console.log(`  🎓 Inferring ${user.name}'s domain expertise...`);
        profile.expertise = await inferExpertise(userSentEmails, userDocuments);
    }
    
    // Analyze working patterns from calendar
    if (calendarEvents && calendarEvents.length >= 10) {
        profile.workingPatterns = analyzeWorkingPatterns(calendarEvents, user.email);
    }
    
    return profile;
}

/**
 * Analyze working patterns from calendar events
 * 
 * @param {Array} events - Calendar events
 * @param {string} userEmail - User's email
 * @returns {Object} - Working pattern analysis
 */
function analyzeWorkingPatterns(events, userEmail) {
    // Meeting frequency
    const meetingsPerWeek = events.length / Math.max(1, getDurationInWeeks(events));
    
    // Meeting types (1:1 vs group)
    const oneOnOnes = events.filter(e => (e.attendees || []).length <= 2).length;
    const groupMeetings = events.filter(e => (e.attendees || []).length > 2).length;
    
    // Response patterns (organizer vs attendee)
    const organized = events.filter(e => {
        const organizer = e.organizer?.email || '';
        return organizer.toLowerCase().includes(userEmail.toLowerCase());
    }).length;
    
    return {
        meetingsPerWeek: Math.round(meetingsPerWeek),
        oneOnOneRatio: oneOnOnes / Math.max(1, events.length),
        organizerRatio: organized / Math.max(1, events.length),
        totalMeetings: events.length,
        preferredMeetingSize: oneOnOnes > groupMeetings ? 'small' : 'large'
    };
}

/**
 * Get duration in weeks from event date range
 */
function getDurationInWeeks(events) {
    const dates = events
        .map(e => new Date(e.start?.dateTime || e.start?.date))
        .filter(d => !isNaN(d.getTime()))
        .sort((a, b) => a - b);
    
    if (dates.length < 2) return 1;
    
    const earliest = dates[0];
    const latest = dates[dates.length - 1];
    const days = (latest - earliest) / (1000 * 60 * 60 * 24);
    return Math.max(1, days / 7);
}

module.exports = {
    analyzeCommunicationStyle,
    inferExpertise,
    analyzeRelationshipStrength,
    buildUserProfile,
    analyzeWorkingPatterns
};

