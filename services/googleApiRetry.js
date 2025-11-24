/**
 * Google API Retry Utility
 *
 * Provides retry logic with exponential backoff for Google API calls
 */

const fetch = require('node-fetch');

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if error is retryable
 * @param {number} statusCode - HTTP status code
 * @returns {boolean} - True if error is retryable
 */
function isRetryableError(statusCode) {
    // Retry on rate limits (429), server errors (5xx), and timeouts
    return statusCode === 429 || 
           (statusCode >= 500 && statusCode < 600) ||
           statusCode === 408; // Request timeout
}

/**
 * Fetch with retry logic
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} maxRetries - Maximum number of retries (default: 3)
 * @param {number} retryCount - Current retry attempt (internal)
 * @returns {Promise<Response>} - Fetch response
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3, retryCount = 0) {
    // Create AbortController for timeout (AbortSignal.timeout not available in all Node versions)
    const controller = new AbortController();
    let timeoutId = null;

    try {
        timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });

        if (timeoutId) clearTimeout(timeoutId);

        // If successful or non-retryable error, return immediately
        if (response.ok || !isRetryableError(response.status)) {
            return response;
        }

        // Retryable error - attempt retry
        if (retryCount < maxRetries) {
            // Calculate backoff: exponential with jitter
            const baseDelay = 1000; // 1 second
            const maxDelay = 10000; // 10 seconds
            const exponentialDelay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
            const jitter = Math.random() * 1000; // Add up to 1 second jitter
            const delay = exponentialDelay + jitter;

            // For rate limits, check Retry-After header
            let waitTime = delay;
            if (response.status === 429) {
                const retryAfter = response.headers.get('retry-after');
                if (retryAfter) {
                    waitTime = Math.max(parseInt(retryAfter) * 1000, delay);
                }
            }

            console.log(`⏳ Google API error ${response.status}, retrying in ${(waitTime/1000).toFixed(1)}s (attempt ${retryCount + 1}/${maxRetries})...`);
            await sleep(waitTime);

            return fetchWithRetry(url, options, maxRetries, retryCount + 1);
        }

        // Max retries exceeded
        return response;
    } catch (error) {
        if (timeoutId) clearTimeout(timeoutId);
        
        // Handle abort/timeout errors
        if (error.name === 'AbortError') {
            if (retryCount < maxRetries) {
                const delay = 1000 * Math.pow(2, retryCount);
                console.log(`⏳ Request timeout, retrying in ${(delay/1000).toFixed(1)}s (attempt ${retryCount + 1}/${maxRetries})...`);
                await sleep(delay);
                return fetchWithRetry(url, options, maxRetries, retryCount + 1);
            }
            throw new Error('Request timeout after retries');
        }
        
        // Network errors are retryable
        if (retryCount < maxRetries && (error.name === 'TypeError' || error.message.includes('fetch'))) {
            const delay = 1000 * Math.pow(2, retryCount);
            console.log(`⏳ Network error, retrying in ${(delay/1000).toFixed(1)}s (attempt ${retryCount + 1}/${maxRetries})...`);
            await sleep(delay);
            return fetchWithRetry(url, options, maxRetries, retryCount + 1);
        }
        throw error;
    }
}

module.exports = {
    fetchWithRetry,
    isRetryableError
};

