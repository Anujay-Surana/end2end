/**
 * Temporal Scoring Service
 * 
 * Provides intelligent time-based relevance scoring for emails, documents, and events
 * Implements decay functions, staleness detection, and trend analysis
 */

/**
 * Calculate recency score using exponential decay
 * 
 * @param {Date|string} date - The date of the content
 * @param {number} lambda - Decay rate (default: 0.01 for slow decay)
 * @returns {number} - Score between 0 and 1 (1 = today, approaches 0 as time passes)
 */
function calculateRecencyScore(date, lambda = 0.01) {
    if (!date) return 0.5; // Unknown date gets middle score
    
    const contentDate = typeof date === 'string' ? new Date(date) : date;
    const now = new Date();
    const daysOld = Math.max(0, (now - contentDate) / (1000 * 60 * 60 * 24));
    
    // Exponential decay: score = e^(-λ * days)
    // λ = 0.01 gives half-life of ~69 days
    // λ = 0.02 gives half-life of ~35 days (more aggressive)
    const score = Math.exp(-lambda * daysOld);
    
    return Math.max(0, Math.min(1, score));
}

/**
 * Calculate relevance score with recency weighting
 * 
 * @param {number} baseRelevance - Base relevance score (0-1)
 * @param {Date|string} date - Content date
 * @param {Object} options - Scoring options
 * @returns {number} - Final weighted score (0-1)
 */
function calculateWeightedScore(baseRelevance, date, options = {}) {
    const {
        recencyWeight = 0.3,  // How much to weight recency (0 = ignore time, 1 = only time matters)
        lambda = 0.015        // Decay rate (~46 day half-life)
    } = options;
    
    const recencyScore = calculateRecencyScore(date, lambda);
    
    // Weighted combination: 70% relevance, 30% recency (by default)
    const finalScore = (baseRelevance * (1 - recencyWeight)) + (recencyScore * recencyWeight);
    
    return finalScore;
}

/**
 * Detect if content contains outdated temporal references
 * 
 * @param {string} text - Content text to analyze
 * @returns {Object} - Staleness detection result
 */
function detectStaleness(text) {
    if (!text) return { isStale: false, indicators: [] };
    
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentQuarter = Math.floor(now.getMonth() / 3) + 1;
    const currentMonth = now.getMonth() + 1;
    
    const indicators = [];
    
    // Check for old year references (2+ years old)
    const yearMatches = text.match(/\b(20\d{2})\b/g) || [];
    const oldYears = yearMatches.filter(y => parseInt(y) < currentYear - 1);
    if (oldYears.length > 0) {
        indicators.push({
            type: 'old_year',
            value: [...new Set(oldYears)].join(', '),
            severity: 'medium'
        });
    }
    
    // Check for old quarter references
    const quarterMatches = text.match(/Q[1-4]\s*(20\d{2})?/gi) || [];
    quarterMatches.forEach(match => {
        const year = match.match(/20\d{2}/);
        const quarter = parseInt(match.match(/Q([1-4])/i)[1]);
        const referenceYear = year ? parseInt(year[0]) : currentYear;
        
        if (referenceYear < currentYear || (referenceYear === currentYear && quarter < currentQuarter - 1)) {
            indicators.push({
                type: 'old_quarter',
                value: match,
                severity: 'high'
            });
        }
    });
    
    // Check for "last week/month" but content is months old
    const relativeTimeMatches = text.match(/\b(last|this|next)\s+(week|month|quarter)\b/gi) || [];
    if (relativeTimeMatches.length > 0) {
        indicators.push({
            type: 'relative_time',
            value: relativeTimeMatches.join(', '),
            severity: 'low',
            note: 'Contains relative time references - verify content date'
        });
    }
    
    // Check for "upcoming" or "planned" with old dates
    const upcomingMatches = text.match(/\b(upcoming|planned|scheduled for|launching)\b/gi);
    if (upcomingMatches && oldYears.length > 0) {
        indicators.push({
            type: 'future_reference_in_old_content',
            value: 'References upcoming/planned events but content is from ' + oldYears[0],
            severity: 'high'
        });
    }
    
    const isStale = indicators.some(i => i.severity === 'high' || i.severity === 'medium');
    
    return {
        isStale,
        indicators,
        stalenessScore: indicators.length > 0 ? Math.min(1, indicators.length * 0.25) : 0
    };
}

/**
 * Analyze trend/velocity from timeline events
 * 
 * @param {Array} events - Array of timeline events with dates
 * @returns {Object} - Trend analysis
 */
function analyzeTrend(events) {
    if (!events || events.length < 2) {
        return {
            trend: 'insufficient_data',
            velocity: 0,
            description: 'Not enough events to detect trend'
        };
    }
    
    // Sort by date
    const sortedEvents = events
        .filter(e => e.date || e.start?.dateTime)
        .map(e => ({
            ...e,
            timestamp: new Date(e.date || e.start.dateTime).getTime()
        }))
        .sort((a, b) => a.timestamp - b.timestamp);
    
    if (sortedEvents.length < 2) {
        return {
            trend: 'insufficient_data',
            velocity: 0,
            description: 'Not enough dated events'
        };
    }
    
    // Calculate time between events (velocity)
    const intervals = [];
    for (let i = 1; i < sortedEvents.length; i++) {
        const daysBetween = (sortedEvents[i].timestamp - sortedEvents[i-1].timestamp) / (1000 * 60 * 60 * 24);
        intervals.push(daysBetween);
    }
    
    const avgInterval = intervals.reduce((sum, val) => sum + val, 0) / intervals.length;
    const recentInterval = intervals[intervals.length - 1]; // Most recent gap
    
    // Determine trend
    let trend, velocity, description;
    
    if (recentInterval < avgInterval * 0.5) {
        trend = 'accelerating';
        velocity = avgInterval / Math.max(1, recentInterval);
        description = `Activity is accelerating (${Math.round(recentInterval)} days between recent events vs ${Math.round(avgInterval)} day average)`;
    } else if (recentInterval > avgInterval * 2) {
        trend = 'decelerating';
        velocity = recentInterval / avgInterval;
        description = `Activity is slowing down (${Math.round(recentInterval)} days between recent events vs ${Math.round(avgInterval)} day average)`;
    } else {
        trend = 'steady';
        velocity = 1;
        description = `Steady activity (~${Math.round(avgInterval)} days between events)`;
    }
    
    // Check for recent activity spike
    const last7Days = sortedEvents.filter(e => {
        const daysAgo = (Date.now() - e.timestamp) / (1000 * 60 * 60 * 24);
        return daysAgo <= 7;
    }).length;
    
    if (last7Days >= 3) {
        description += `. HIGH ACTIVITY: ${last7Days} events in last 7 days`;
    }
    
    return {
        trend,
        velocity,
        description,
        avgInterval: Math.round(avgInterval),
        recentInterval: Math.round(recentInterval),
        totalEvents: sortedEvents.length,
        recentEvents: last7Days
    };
}

/**
 * Detect "what changed since last meeting" from timeline
 * 
 * @param {Array} timeline - Array of events/emails/docs
 * @param {Date} lastMeetingDate - Date of previous similar meeting
 * @returns {Object} - Change analysis
 */
function analyzeChangesSinceLastMeeting(timeline, lastMeetingDate) {
    if (!lastMeetingDate || !timeline || timeline.length === 0) {
        return {
            hasChanges: false,
            newEvents: [],
            description: 'No previous meeting date or timeline data'
        };
    }
    
    const lastDate = typeof lastMeetingDate === 'string' ? new Date(lastMeetingDate) : lastMeetingDate;
    
    // Find events after last meeting
    const newEvents = timeline.filter(event => {
        const eventDate = new Date(event.date || event.start?.dateTime || event.modifiedTime);
        return eventDate > lastDate;
    });
    
    if (newEvents.length === 0) {
        return {
            hasChanges: false,
            newEvents: [],
            description: `No new activity since last meeting on ${lastDate.toLocaleDateString()}`
        };
    }
    
    // Categorize changes
    const categories = {
        emails: newEvents.filter(e => e.type === 'email').length,
        documents: newEvents.filter(e => e.type === 'document').length,
        meetings: newEvents.filter(e => e.type === 'meeting').length,
        other: newEvents.filter(e => !['email', 'document', 'meeting'].includes(e.type)).length
    };
    
    const description = `${newEvents.length} new events since ${lastDate.toLocaleDateString()}: ` +
        Object.entries(categories)
            .filter(([_, count]) => count > 0)
            .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
            .join(', ');
    
    return {
        hasChanges: true,
        newEvents,
        categories,
        description,
        daysSinceLastMeeting: Math.floor((Date.now() - lastDate) / (1000 * 60 * 60 * 24))
    };
}

/**
 * Score and rank emails by combined relevance and recency
 * 
 * @param {Array} emails - Array of email objects
 * @param {number} baseRelevanceScore - Base relevance (0-1)
 * @param {Object} options - Scoring options
 * @returns {Array} - Emails with scores, sorted by final score
 */
function scoreAndRankEmails(emails, baseRelevanceScore = 0.8, options = {}) {
    const {
        recencyWeight = 0.3,
        attendeeBoost = 0.1,   // Boost for emails with multiple attendees
        threadBoost = 0.1       // Boost for emails in longer threads
    } = options;
    
    return emails.map(email => {
        let score = baseRelevanceScore;
        
        // Apply recency decay
        const recencyScore = calculateRecencyScore(email.date, 0.015);
        score = (score * (1 - recencyWeight)) + (recencyScore * recencyWeight);
        
        // Boost for multiple attendees (indicates collaboration)
        if (email._attendeeCount && email._attendeeCount > 2) {
            score += attendeeBoost * Math.min(1, email._attendeeCount / 10);
        }
        
        // Boost for emails in active threads
        if (email._threadInfo && email._threadInfo.messageCount > 3) {
            score += threadBoost * Math.min(1, email._threadInfo.messageCount / 10);
        }
        
        return {
            ...email,
            _temporalScore: score,
            _recencyScore: recencyScore,
            _daysOld: email.date ? Math.floor((Date.now() - new Date(email.date)) / (1000 * 60 * 60 * 24)) : null
        };
    }).sort((a, b) => b._temporalScore - a._temporalScore);
}

module.exports = {
    calculateRecencyScore,
    calculateWeightedScore,
    detectStaleness,
    analyzeTrend,
    analyzeChangesSinceLastMeeting,
    scoreAndRankEmails
};

