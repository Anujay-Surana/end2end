/**
 * GPT Service
 *
 * Centralized OpenAI GPT-5 API client with retry logic and helper functions
 */

const fetch = require('node-fetch');

/**
 * Sleep helper for rate limiting
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call OpenAI GPT-5 for analysis with automatic retry on rate limits
 * @param {Array} messages - Array of message objects with role and content
 * @param {number} maxTokens - Maximum tokens to generate (default: 1000)
 * @param {number} retryCount - Current retry attempt (internal use)
 * @returns {Promise<string>} - GPT response content
 */
async function callGPT(messages, maxTokens = 1000, retryCount = 0) {
    const maxRetries = 3;
    const timeoutMs = 60000; // 60 second timeout

    try {
        // Create AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-5',
                messages,
                temperature: 0.7,
                max_tokens: maxTokens
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorBody = await response.text();
            let errorDetails = '';
            let errorJson = null;

            try {
                errorJson = JSON.parse(errorBody);
                errorDetails = JSON.stringify(errorJson, null, 2);
            } catch {
                errorDetails = errorBody;
            }

            // Handle rate limit errors with automatic retry
            if (response.status === 429 && retryCount < maxRetries) {
                const retryAfter = response.headers.get('retry-after');
                let waitTime = retryAfter ? parseFloat(retryAfter) * 1000 : 5000;

                // If we have the error message, try to parse wait time from it
                if (errorJson?.error?.message) {
                    const match = errorJson.error.message.match(/Please try again in ([\d.]+)s/);
                    if (match) {
                        waitTime = Math.ceil(parseFloat(match[1]) * 1000);
                    }
                }

                console.log(`⏳ Rate limit hit. Waiting ${(waitTime/1000).toFixed(1)}s before retry ${retryCount + 1}/${maxRetries}...`);
                await sleep(waitTime);

                // Retry the request
                return await callGPT(messages, maxTokens, retryCount + 1);
            }

            // For non-429 errors or exhausted retries, log and throw
            const rateLimitReset = response.headers.get('x-ratelimit-reset-tokens');
            console.error(`❌ OpenAI API Error ${response.status}:`);
            console.error(`   Error Details: ${errorDetails}`);
            if (response.status === 429 && retryCount >= maxRetries) {
                console.error(`   ⚠️  Max retries (${maxRetries}) exceeded`);
            }

            throw new Error(`GPT API error: ${response.status} - ${errorDetails}`);
        }

        const data = await response.json();
        return data.choices[0].message.content.trim();

    } catch (error) {
        // Handle timeout/abort errors
        if (error.name === 'AbortError') {
            throw new Error('GPT API request timed out after 60 seconds');
        }

        // If it's a network error and we haven't exceeded retries, retry with exponential backoff
        if (retryCount < maxRetries && (error.message.includes('fetch') || error.message.includes('timeout'))) {
            const waitTime = Math.min(1000 * Math.pow(2, retryCount), 10000); // Cap at 10s
            console.log(`⏳ Network error. Waiting ${(waitTime/1000).toFixed(1)}s before retry ${retryCount + 1}/${maxRetries}...`);
            await sleep(waitTime);
            return await callGPT(messages, maxTokens, retryCount + 1);
        }
        throw error;
    }
}

/**
 * Synthesize results with strict fact-checking
 * @param {string} prompt - The synthesis prompt
 * @param {Object} data - Data to synthesize
 * @param {number} maxTokens - Maximum tokens (default: 500)
 * @returns {Promise<string|null>} - Synthesized result or null on error
 */
async function synthesizeResults(prompt, data, maxTokens = 500) {
    try {
        const result = await callGPT([{
            role: 'system',
            content: `You are an executive briefing expert. Your task is to extract and synthesize information from data based on the specific prompt provided.

CORE PRINCIPLES:
1. **Verify before including**: ONLY include information directly supported by the provided data
2. **Be specific**: Include numbers, dates, names, companies, titles, concrete details
3. **Context-appropriate length**:
   - For fact extraction: 15-80 words per fact
   - For narrative synthesis: Follow prompt guidance (typically 6-12 sentences)
4. **Quality over quantity**: Return fewer high-quality insights rather than padding with generic statements
5. **Skip obvious/generic**: No "experienced professional", "works in tech", "team member" unless there's specific detail
6. **Business relevance**: Focus on information useful for meeting preparation and decision-making

OUTPUT FORMAT:
- Follow the prompt's explicit output format instructions (JSON array, paragraph, etc.)
- If prompt asks for JSON, return valid JSON only (no markdown code blocks unless you strip them)
- If prompt asks for narrative, write cohesive prose
- If data is insufficient for quality output, acknowledge it explicitly

VALIDATION CHECKS:
- Does each statement have evidence in the data?
- Would this information actually help in a meeting context?
- Is this specific enough to be actionable?
- Have I followed the prompt's specific instructions?`
        }, {
            role: 'user',
            content: `${prompt}\n\nData:\n${JSON.stringify(data).substring(0, 12000)}`
        }], maxTokens);

        if (!result || result.trim().length === 0) {
            console.warn('⚠️  synthesizeResults returned empty result');
            return null;
        }
        return result;
    } catch (error) {
        console.error('❌ Error synthesizing:', error.message);
        console.error('Error stack:', error.stack);
        return null;
    }
}

/**
 * Safely parse JSON that may be wrapped in markdown code blocks
 * Only strips backticks at the START and END, not throughout the content
 * @param {string} text - JSON string that may have markdown code blocks
 * @returns {Object|null} - Parsed JSON object or null on error
 */
function safeParseJSON(text) {
    if (!text) {
        console.warn('⚠️  safeParseJSON received null/undefined text');
        return null;
    }

    let cleaned = text.trim();
    
    // Log what we're trying to parse (first 200 chars for debugging)
    if (cleaned.length < 200) {
        console.log(`🔍 Parsing JSON (full): ${cleaned}`);
    } else {
        console.log(`🔍 Parsing JSON (first 200 chars): ${cleaned.substring(0, 200)}...`);
    }

    // Remove markdown code blocks ONLY at start/end (not in the middle of content)
    // This prevents corrupting JSON that contains backticks in its content
    if (cleaned.startsWith('```')) {
        // Remove opening code block (```json or just ```)
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '');
    }

    if (cleaned.endsWith('```')) {
        // Remove closing code block
        cleaned = cleaned.replace(/\n?```\s*$/, '');
    }

    // Try direct parse first
    try {
        const parsed = JSON.parse(cleaned.trim());
        console.log(`✅ JSON parsed successfully: ${Array.isArray(parsed) ? `Array with ${parsed.length} items` : typeof parsed}`);
        return parsed;
    } catch (error) {
        console.error(`❌ Error parsing JSON: ${error.message}`);
        console.error(`   Text being parsed: ${cleaned.substring(0, 300)}`);
        
        // Try to extract JSON array from narrative text
        // Look for array-like patterns: [...]
        const arrayMatch = cleaned.match(/\[[\s\S]*?\]/);
        if (arrayMatch) {
            try {
                const extracted = JSON.parse(arrayMatch[0]);
                console.log(`✅ Extracted JSON array from text: ${Array.isArray(extracted) ? `Array with ${extracted.length} items` : typeof extracted}`);
                return extracted;
            } catch (e) {
                console.error(`   Failed to parse extracted array: ${e.message}`);
            }
        }
        
        // Try to find JSON object if array not found
        const objectMatch = cleaned.match(/\{[\s\S]*\}/);
        if (objectMatch) {
            try {
                const extracted = JSON.parse(objectMatch[0]);
                console.log(`✅ Extracted JSON object from text: ${typeof extracted}`);
                // If it's an object with an array property, return that
                if (extracted.facts && Array.isArray(extracted.facts)) {
                    return extracted.facts;
                }
                if (extracted.items && Array.isArray(extracted.items)) {
                    return extracted.items;
                }
                return extracted;
            } catch (e) {
                console.error(`   Failed to parse extracted object: ${e.message}`);
            }
        }
        
        return null;
    }
}

/**
 * Craft search queries from context
 * @param {string} context - Context to generate queries from
 * @returns {Promise<Array>} - Array of search queries (max 3)
 */
async function craftSearchQueries(context) {
    try {
        const result = await callGPT([{
            role: 'system',
            content: 'Generate EXACTLY 3 highly specific web search queries. Return ONLY a JSON array. Example: ["query 1", "query 2", "query 3"]'
        }, {
            role: 'user',
            content: context
        }], 200);

        const parsed = safeParseJSON(result);
        return Array.isArray(parsed) ? parsed.slice(0, 3) : [];
    } catch (error) {
        console.error('Error crafting queries:', error);
        return [];
    }
}

module.exports = {
    callGPT,
    synthesizeResults,
    safeParseJSON,
    craftSearchQueries,
    sleep
};

