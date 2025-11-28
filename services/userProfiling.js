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
 * Extract company name from email domain
 * 
 * @param {string} email - User's email address
 * @returns {Object} - Company information
 */
function inferCompanyFromEmail(email) {
    if (!email || !email.includes('@')) {
        return { company: null, domain: null };
    }
    
    const domain = email.split('@')[1];
    if (!domain) {
        return { company: null, domain: null };
    }
    
    // Extract company name from domain (e.g., "kordn8.ai" -> "Kordn8")
    const domainParts = domain.split('.');
    const companyPart = domainParts[0];
    
    // Capitalize first letter
    const company = companyPart.charAt(0).toUpperCase() + companyPart.slice(1);
    
    return {
        company: company,
        domain: domain,
        source: 'email_domain'
    };
}

/**
 * Extract location and travel patterns from calendar events
 * 
 * @param {Array} calendarEvents - User's calendar events
 * @returns {Object} - Location and travel data
 */
function extractLocationAndTravelPatterns(calendarEvents) {
    if (!calendarEvents || calendarEvents.length === 0) {
        return {
            location: null,
            travelPatterns: null
        };
    }
    
    const locations = [];
    const timezones = new Set();
    
    // Extract locations from events
    calendarEvents.forEach(event => {
        if (event.location) {
            locations.push(event.location);
        }
        
        // Try to infer timezone from event times
        if (event.start?.dateTime) {
            const startDate = new Date(event.start.dateTime);
            // Compare UTC vs local time to infer timezone
            const utcOffset = startDate.getTimezoneOffset();
            timezones.add(utcOffset);
        }
    });
    
    // Extract cities from locations
    const cityCounts = {};
    locations.forEach(loc => {
        // Simple extraction: look for city patterns
        // Common patterns: "City, State", "City, Country", "City"
        const cityMatch = loc.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
        if (cityMatch) {
            const city = cityMatch[1];
            cityCounts[city] = (cityCounts[city] || 0) + 1;
        }
    });
    
    // Find primary location (most frequent city)
    const sortedCities = Object.entries(cityCounts)
        .sort((a, b) => b[1] - a[1]);
    const primaryLocation = sortedCities.length > 0 ? sortedCities[0][0] : null;
    const frequentLocations = sortedCities.slice(0, 5).map(([city]) => city);
    
    // Determine travel frequency
    const uniqueCities = Object.keys(cityCounts).length;
    let travelFrequency = 'rare';
    if (uniqueCities >= 5) {
        travelFrequency = 'frequent';
    } else if (uniqueCities >= 2) {
        travelFrequency = 'occasional';
    }
    
    // Infer timezone from most common UTC offset
    const timezoneOffsets = Array.from(timezones);
    const mostCommonOffset = timezoneOffsets.length > 0 
        ? timezoneOffsets.sort((a, b) => {
            const countA = timezoneOffsets.filter(o => o === a).length;
            const countB = timezoneOffsets.filter(o => o === b).length;
            return countB - countA;
        })[0]
        : null;
    
    // Convert UTC offset to timezone (approximate)
    let timezone = null;
    if (mostCommonOffset !== null) {
        // Common timezone mappings (approximate)
        if (mostCommonOffset === -480) timezone = 'America/Los_Angeles'; // PST
        else if (mostCommonOffset === -420) timezone = 'America/Denver'; // MST
        else if (mostCommonOffset === -300) timezone = 'America/New_York'; // EST
        else if (mostCommonOffset === 0) timezone = 'Europe/London'; // GMT
        else if (mostCommonOffset === 330) timezone = 'Asia/Kolkata'; // IST
    }
    
    return {
        location: primaryLocation ? {
            city: primaryLocation,
            timezone: timezone
        } : null,
        travelPatterns: {
            primaryLocation: primaryLocation || null,
            frequentLocations: frequentLocations,
            travelFrequency: travelFrequency,
            uniqueCities: uniqueCities
        }
    };
}

/**
 * Extract biographical information from email signatures and content
 * Uses both sent and received emails for comprehensive context
 * 
 * @param {Array} userSentEmails - Emails sent by the user
 * @param {Array} userReceivedEmails - Emails received by the user
 * @returns {Promise<Object>} - Biographical data
 */
async function extractBiographicalInfo(userSentEmails = [], userReceivedEmails = []) {
    // Combine both email sets, prioritizing sent emails
    const allEmailsForAnalysis = [
        ...userSentEmails.slice(0, 15).map(e => ({ ...e, source: 'sent' })),
        ...userReceivedEmails.slice(0, 10).map(e => ({ ...e, source: 'received' }))
    ];
    
    if (allEmailsForAnalysis.length === 0) {
        return {
            jobTitle: null,
            company: null,
            location: null,
            phone: null
        };
    }
    
    // Extract email signatures and relevant content
    const emailSamples = allEmailsForAnalysis.map(e => {
        const body = (e.body || e.snippet || '').trim();
        // Extract last 15 lines (likely signature area)
        const lines = body.split('\n');
        const signatureLines = lines.slice(-15).join('\n');
        
        return {
            source: e.source,
            subject: e.subject,
            from: e.from,
            to: e.to,
            body: body.substring(0, 2000), // Full body for context
            signature: signatureLines, // Last 15 lines (signature area)
            date: e.date
        };
    });
    
    try {
        const analysis = await callGPT([{
            role: 'system',
            content: `Extract biographical information from email signatures and content. Analyze BOTH sent emails (user's own signatures) and received emails (how others address the user).

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

Prioritize information from sent emails (user's own signatures) but also use received emails for context.`
        }, {
            role: 'user',
            content: `Email samples (sent=${userSentEmails.length}, received=${userReceivedEmails.length}):\n${JSON.stringify(emailSamples, null, 2)}`
        }], 1200);
        
        const biographicalData = safeParseJSON(analysis);
        return {
            jobTitle: biographicalData.jobTitle || null,
            company: biographicalData.company || null,
            location: biographicalData.location || null,
            phone: biographicalData.phone || null,
            confidence: biographicalData.confidence || 'low'
        };
    } catch (e) {
        console.log(`  ⚠️  Biographical info extraction failed: ${e.message}`);
        return {
            jobTitle: null,
            company: null,
            location: null,
            phone: null,
            confidence: 'low'
        };
    }
}

/**
 * Extract role and company information from email content
 * Analyzes both sent and received emails for comprehensive context
 * 
 * @param {Array} userSentEmails - Emails sent by the user
 * @param {Array} userReceivedEmails - Emails received by the user
 * @returns {Promise<Object>} - Role and company information
 */
async function extractRoleFromEmailContent(userSentEmails = [], userReceivedEmails = []) {
    // Combine both email sets
    const allEmailsForAnalysis = [
        ...userSentEmails.slice(0, 20).map(e => ({ ...e, source: 'sent' })),
        ...userReceivedEmails.slice(0, 15).map(e => ({ ...e, source: 'received' }))
    ];
    
    if (allEmailsForAnalysis.length === 0) {
        return {
            jobTitle: null,
            company: null,
            confidence: 'low'
        };
    }
    
    // Extract relevant content from emails
    const emailContent = allEmailsForAnalysis.map(e => {
        const body = (e.body || e.snippet || '').trim();
        return {
            source: e.source,
            subject: e.subject,
            from: e.from,
            to: e.to,
            content: body.substring(0, 1500), // First 1500 chars (intro + signature area)
            date: e.date
        };
    });
    
    try {
        const analysis = await callGPT([{
            role: 'system',
            content: `Extract job title and company information from email content. Analyze BOTH sent emails (user's self-descriptions) and received emails (how others address/refer to the user).

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

Prioritize sent emails but use received emails for additional context.`
        }, {
            role: 'user',
            content: `Email content (sent=${userSentEmails.length}, received=${userReceivedEmails.length}):\n${JSON.stringify(emailContent, null, 2)}`
        }], 1200);
        
        const roleData = safeParseJSON(analysis);
        return {
            jobTitle: roleData.jobTitle || null,
            company: roleData.company || null,
            confidence: roleData.confidence || 'low',
            evidence: roleData.evidence || []
        };
    } catch (e) {
        console.log(`  ⚠️  Role extraction failed: ${e.message}`);
        return {
            jobTitle: null,
            company: null,
            confidence: 'low',
            evidence: []
        };
    }
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
        biographicalInfo: null,
        relationships: []
    };
    
    const userEmailLower = user.email.toLowerCase();
    
    // Extract user's sent emails (FROM user)
    const userSentEmails = allEmails.filter(e => {
        const from = (e.from || '').toLowerCase();
        return from.includes(userEmailLower);
    });
    
    // Extract user's received emails (TO user or user in recipients)
    const userReceivedEmails = allEmails.filter(e => {
        const to = (e.to || '').toLowerCase();
        const cc = (e.cc || '').toLowerCase();
        const bcc = (e.bcc || '').toLowerCase();
        return to.includes(userEmailLower) || 
               cc.includes(userEmailLower) || 
               bcc.includes(userEmailLower);
    });
    
    // Extract user's documents
    const userDocuments = allDocuments.filter(d => {
        const owner = (d.ownerEmail || d.owner || '').toLowerCase();
        return owner.includes(userEmailLower);
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
    
    // Extract biographical information
    console.log(`  📋 Extracting biographical info (sent: ${userSentEmails.length}, received: ${userReceivedEmails.length})...`);
    
    // Extract from email signatures and content
    const biographicalFromEmails = await extractBiographicalInfo(userSentEmails, userReceivedEmails);
    
    // Extract role/company from email content
    const roleFromContent = await extractRoleFromEmailContent(userSentEmails, userReceivedEmails);
    
    // Extract company from email domain
    const companyFromDomain = inferCompanyFromEmail(user.email);
    
    // Extract location/travel from calendar
    const locationAndTravel = extractLocationAndTravelPatterns(calendarEvents);
    
    // Merge location data (combine email and calendar sources)
    let mergedLocation = null;
    if (biographicalFromEmails.location || locationAndTravel.location) {
        mergedLocation = {
            city: biographicalFromEmails.location?.city || locationAndTravel.location?.city || null,
            state: biographicalFromEmails.location?.state || null,
            country: biographicalFromEmails.location?.country || null,
            timezone: biographicalFromEmails.location?.timezone || locationAndTravel.location?.timezone || null
        };
        // Remove null values
        Object.keys(mergedLocation).forEach(key => {
            if (mergedLocation[key] === null) {
                delete mergedLocation[key];
            }
        });
        if (Object.keys(mergedLocation).length === 0) {
            mergedLocation = null;
        }
    }
    
    // Merge biographical information (prioritize email signatures, then content, then domain)
    profile.biographicalInfo = {
        jobTitle: biographicalFromEmails.jobTitle || roleFromContent.jobTitle || null,
        company: biographicalFromEmails.company || roleFromContent.company || companyFromDomain.company || null,
        location: mergedLocation,
        phone: biographicalFromEmails.phone || null,
        travelPatterns: locationAndTravel.travelPatterns,
        confidence: biographicalFromEmails.confidence || roleFromContent.confidence || 'low',
        sources: {
            emailDomain: companyFromDomain.company ? 'email_domain' : null,
            emailSignatures: biographicalFromEmails.jobTitle || biographicalFromEmails.company ? 'email_signatures' : null,
            emailContent: roleFromContent.jobTitle || roleFromContent.company ? 'email_content' : null,
            calendar: locationAndTravel.location ? 'calendar' : null
        }
    };
    
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
    analyzeWorkingPatterns,
    extractBiographicalInfo,
    extractLocationAndTravelPatterns,
    inferCompanyFromEmail,
    extractRoleFromEmailContent
};

