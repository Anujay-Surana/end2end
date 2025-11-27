/**
 * Dynamic Thresholds Service
 * 
 * Provides adaptive filtering thresholds based on data quality distribution
 * Replaces static "include 60-80%" with intelligent percentile-based selection
 */

/**
 * Calculate optimal cutoff threshold based on score distribution
 * Uses the "elbow method" to find natural breakpoint in scores
 * 
 * @param {Array} scores - Array of relevance scores (0-1)
 * @param {Object} options - Threshold options
 * @returns {number} - Optimal cutoff threshold
 */
function calculateOptimalCutoff(scores, options = {}) {
    const {
        minPercentile = 50,     // At least top 50% if all scores are low
        maxPercentile = 90,     // At most top 90% even if all scores are high
        qualityThreshold = 0.7  // Absolute quality threshold - include all above this
    } = options;
    
    if (!scores || scores.length === 0) return 0;
    if (scores.length === 1) return scores[0];
    
    // Sort scores descending
    const sortedScores = [...scores].sort((a, b) => b - a);
    
    // If top score is below quality threshold, use percentile-based approach
    if (sortedScores[0] < qualityThreshold) {
        // Low overall quality - be more selective
        const percentileIndex = Math.floor(sortedScores.length * (minPercentile / 100));
        return sortedScores[Math.min(percentileIndex, sortedScores.length - 1)];
    }
    
    // High quality data - find the "elbow" where scores drop significantly
    let maxDrop = 0;
    let elbowIndex = 0;
    
    for (let i = 0; i < sortedScores.length - 1; i++) {
        const drop = sortedScores[i] - sortedScores[i + 1];
        if (drop > maxDrop) {
            maxDrop = drop;
            elbowIndex = i;
        }
    }
    
    // If there's a significant drop (>0.15), use that as cutoff
    if (maxDrop > 0.15) {
        return sortedScores[elbowIndex + 1];
    }
    
    // Otherwise, use quality threshold
    // Find first score below quality threshold
    const thresholdIndex = sortedScores.findIndex(s => s < qualityThreshold);
    if (thresholdIndex > 0) {
        return sortedScores[thresholdIndex];
    }
    
    // All scores are high quality - include more
    const percentileIndex = Math.floor(sortedScores.length * (maxPercentile / 100));
    return sortedScores[Math.min(percentileIndex, sortedScores.length - 1)];
}

/**
 * Filter items by adaptive threshold
 * 
 * @param {Array} items - Array of items with _score property
 * @param {Object} options - Filtering options
 * @returns {Array} - Filtered items above threshold
 */
function filterByAdaptiveThreshold(items, options = {}) {
    if (!items || items.length === 0) return [];
    
    const scores = items.map(item => item._score || item._temporalScore || 0);
    const threshold = calculateOptimalCutoff(scores, options);
    
    console.log(`  📊 Adaptive threshold: ${threshold.toFixed(3)} (from ${scores.length} items, min=${Math.min(...scores).toFixed(3)}, max=${Math.max(...scores).toFixed(3)})`);
    
    const filtered = items.filter(item => (item._score || item._temporalScore || 0) >= threshold);
    
    console.log(`  ✓ Selected ${filtered.length}/${items.length} items (${Math.round(filtered.length / items.length * 100)}%)`);
    
    return filtered;
}

/**
 * Determine optimal document count based on quality
 * 
 * @param {Array} documents - Array of documents with quality scores
 * @param {Object} options - Selection options
 * @returns {number} - Optimal number of documents to include
 */
function determineOptimalDocumentCount(documents, options = {}) {
    const {
        minCount = 3,          // Always include at least 3 if available
        maxCount = 25,         // Never exceed 25 even if all are high quality
        qualityThreshold = 0.6 // Minimum quality to consider
    } = options;
    
    if (!documents || documents.length === 0) return 0;
    
    // Filter by quality first
    const qualityDocs = documents.filter(d => (d._score || d._recencyScore || 0) >= qualityThreshold);
    
    if (qualityDocs.length <= minCount) {
        return Math.min(documents.length, minCount);
    }
    
    if (qualityDocs.length >= maxCount) {
        return maxCount;
    }
    
    // Return all quality docs if within reasonable range
    return qualityDocs.length;
}

/**
 * Select timeline events by impact, not just recency
 * 
 * @param {Array} events - Array of timeline events
 * @param {Object} impactScores - Map of event IDs to impact scores
 * @param {number} maxEvents - Maximum events to return
 * @returns {Array} - Selected events sorted by impact
 */
function selectTimelineByImpact(events, impactScores, maxEvents = 100) {
    if (!events || events.length === 0) return [];
    
    // Add impact scores to events
    const scoredEvents = events.map(event => ({
        ...event,
        _impactScore: impactScores[event.id] || 0,
        _recencyScore: event.timestamp ? 
            Math.exp(-0.01 * (Date.now() - event.timestamp) / (1000 * 60 * 60 * 24)) : 0,
        // Combined score: 60% impact, 40% recency
        _finalScore: (impactScores[event.id] || 0) * 0.6 + 
                     (event.timestamp ? Math.exp(-0.01 * (Date.now() - event.timestamp) / (1000 * 60 * 60 * 24)) : 0) * 0.4
    }));
    
    // Sort by combined score
    scoredEvents.sort((a, b) => b._finalScore - a._finalScore);
    
    return scoredEvents.slice(0, maxEvents);
}

/**
 * Calculate signal-to-noise ratio for a dataset
 * 
 * @param {Array} scores - Array of relevance scores
 * @returns {Object} - Signal quality metrics
 */
function calculateSignalQuality(scores) {
    if (!scores || scores.length === 0) {
        return {
            mean: 0,
            median: 0,
            stdDev: 0,
            quality: 'no_data'
        };
    }
    
    const sorted = [...scores].sort((a, b) => b - a);
    const mean = scores.reduce((sum, val) => sum + val, 0) / scores.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    
    const variance = scores.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / scores.length;
    const stdDev = Math.sqrt(variance);
    
    // Determine quality level
    let quality;
    if (mean > 0.7 && median > 0.6) {
        quality = 'high'; // Lots of high-quality signals
    } else if (mean > 0.5 && median > 0.4) {
        quality = 'medium'; // Moderate quality
    } else {
        quality = 'low'; // Mostly noise
    }
    
    return {
        mean,
        median,
        stdDev,
        quality,
        signalToNoise: mean / Math.max(0.01, stdDev), // Higher = more consistent quality
        topPercentile: sorted.slice(0, Math.ceil(sorted.length * 0.1)) // Top 10%
    };
}

module.exports = {
    calculateOptimalCutoff,
    filterByAdaptiveThreshold,
    determineOptimalDocumentCount,
    selectTimelineByImpact,
    calculateSignalQuality
};

