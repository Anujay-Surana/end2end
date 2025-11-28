/**
 * GPT Service
 *
 * Centralized OpenAI GPT-4.1-mini API client with retry logic and helper functions
 */

const fetch = require('node-fetch');

/**
 * Sleep helper for rate limiting
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call OpenAI GPT-4.1-mini for analysis with automatic retry on rate limits
 * @param {Array} messages - Array of message objects with role and content
 * @param {number} maxTokens - Maximum tokens to generate (default: 4000)
 * @param {number} retryCount - Current retry attempt (internal use)
 * @returns {Promise<string>} - GPT response content
 */
async function callGPT(messages, maxTokens = 2000, retryCount = 0) {
    const maxRetries = 3;
    const timeoutMs = 60000; // 60 second timeout

    // Log request details
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const messageCount = Array.isArray(messages) ? messages.length : 0;
    const firstMessagePreview = messages && messages[0] ? (messages[0].content || '').substring(0, 100) : 'N/A';
    
    console.log(`\n📤 [${requestId}] GPT-4.1-mini API Request:`);
    console.log(`   Model: gpt-4.1-mini`);
    console.log(`   Max completion tokens: ${maxTokens}`);
    console.log(`   Messages: ${messageCount}`);
    console.log(`   First message preview: ${firstMessagePreview}...`);
    console.log(`   Retry attempt: ${retryCount + 1}/${maxRetries + 1}`);

    try {
        // Create AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const requestBody = {
            model: 'gpt-4.1-mini',
            messages,
            max_tokens: maxTokens
        };
        
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            console.error(`   ❌ [${requestId}] OPENAI_API_KEY environment variable is not set!`);
            throw new Error('OPENAI_API_KEY environment variable is not set');
        }
        
        // Log API key info (masked for security)
        const apiKeyPreview = apiKey.substring(0, 10) + '...' + apiKey.substring(apiKey.length - 4);
        console.log(`   API Key: ${apiKeyPreview} (length: ${apiKey.length})`);
        console.log(`   Request body: ${JSON.stringify(requestBody, null, 2).substring(0, 500)}...`);

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}` // Use full API key here!
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });

        clearTimeout(timeoutId);
        
        console.log(`\n📥 [${requestId}] GPT-4.1-mini API Response:`);
        console.log(`   Status: ${response.status} ${response.statusText}`);
        console.log(`   Headers:`, Object.fromEntries(response.headers.entries()));

        if (!response.ok) {
            const errorBody = await response.text();
            let errorDetails = '';
            let errorJson = null;

            console.error(`   ❌ [${requestId}] API Error Response Body:`, errorBody.substring(0, 1000));

            try {
                errorJson = JSON.parse(errorBody);
                errorDetails = JSON.stringify(errorJson, null, 2);
                console.error(`   ❌ [${requestId}] Parsed Error:`, errorDetails);
            } catch {
                errorDetails = errorBody;
                console.error(`   ❌ [${requestId}] Raw Error Body:`, errorBody.substring(0, 500));
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

        const responseText = await response.text();
        console.log(`   Response body length: ${responseText.length} chars`);
        console.log(`   Response body preview: ${responseText.substring(0, 500)}...`);
        
        let data;
        try {
            data = JSON.parse(responseText);
        } catch (parseError) {
            console.error(`   ❌ [${requestId}] Failed to parse response as JSON:`, parseError.message);
            console.error(`   Raw response:`, responseText.substring(0, 1000));
            throw new Error(`GPT API returned invalid JSON: ${parseError.message}`);
        }
        
        console.log(`   Response structure:`, {
            hasChoices: !!data.choices,
            choicesLength: data.choices ? data.choices.length : 0,
            hasUsage: !!data.usage,
            model: data.model || 'not provided',
            id: data.id || 'not provided'
        });
        
        // Log full response structure for debugging
        console.log(`   Full response:`, JSON.stringify(data, null, 2).substring(0, 2000));
        
        // Log response for debugging if empty or invalid
        if (!data.choices || !data.choices[0]) {
            console.error(`   ❌ [${requestId}] GPT API returned invalid response structure:`, JSON.stringify(data, null, 2).substring(0, 1000));
            throw new Error(`GPT API returned invalid response: missing choices[0]`);
        }
        
        if (!data.choices[0].message) {
            console.error(`   ❌ [${requestId}] GPT API returned invalid response structure:`, JSON.stringify(data, null, 2).substring(0, 1000));
            throw new Error(`GPT API returned invalid response: missing choices[0].message`);
        }
        
        const message = data.choices[0].message;
        const finishReason = data.choices[0].finish_reason;
        
        // Check for refusal field
        const refusal = message.refusal || null;
        
        console.log(`   Message structure:`, {
            role: message.role,
            hasContent: !!message.content,
            contentLength: message.content ? message.content.length : 0,
            hasToolCalls: !!message.tool_calls,
            finishReason: finishReason,
            hasRefusal: !!refusal,
            refusal: refusal
        });
        
        // Analyze finish_reason for potential issues
        if (finishReason !== 'stop') {
            console.warn(`   ⚠️  [${requestId}] Unusual finish reason: ${finishReason}`);
            if (finishReason === 'content_filter') {
                console.warn(`   ⚠️  Content was filtered by OpenAI's safety system - response may be incomplete`);
            } else if (finishReason === 'length') {
                console.warn(`   ⚠️  Response was truncated due to max_tokens limit (${maxTokens} tokens)`);
            } else if (finishReason === 'tool_calls') {
                console.log(`   ℹ️  Response contains tool calls (function calling)`);
            }
        }
        
        // Handle refusal case
        if (refusal) {
            console.error(`   ❌ [${requestId}] GPT-4.1-mini refused to generate content. Refusal:`, JSON.stringify(refusal, null, 2));
            console.error(`   Model used: gpt-4.1-mini`);
            console.error(`   Usage:`, data.usage ? JSON.stringify(data.usage) : 'not provided');
            console.error(`   Finish reason: ${finishReason}`);
            throw new Error(`GPT-4.1-mini refused to generate content: ${JSON.stringify(refusal)}`);
        }
        
        // Handle empty content (even if refusal is null)
        if (!message.content || (typeof message.content === 'string' && message.content.trim().length === 0)) {
            // Special handling for "length" finish_reason with empty content
            // GPT-4.1-mini may return empty content when hitting token limit if response would be too long
            if (finishReason === 'length' && data.usage?.completion_tokens >= maxTokens * 0.95) {
                console.error(`   ❌ [${requestId}] GPT-4.1-mini hit token limit (${data.usage.completion_tokens}/${maxTokens}) and returned empty content`);
                console.error(`   This suggests the response would exceed the limit. Consider increasing max_tokens.`);
                console.error(`   Model used: gpt-4.1-mini`);
                console.error(`   Usage:`, JSON.stringify(data.usage));
                console.error(`   Finish reason: ${finishReason}`);
                
                // Retry with higher token limit if we haven't exceeded retries
                if (retryCount < maxRetries && maxTokens < 8000) {
                    const newMaxTokens = Math.min(maxTokens * 2, 8000);
                    console.log(`   🔄 [${requestId}] Retrying with increased token limit: ${maxTokens} → ${newMaxTokens}`);
                    return await callGPT(messages, newMaxTokens, retryCount + 1);
                }
                
                throw new Error(`GPT-4.1-mini returned empty content due to token limit (${data.usage.completion_tokens}/${maxTokens}). Try increasing max_tokens.`);
            }
            
            console.error(`   ❌ [${requestId}] GPT-4.1-mini returned empty content. Full response:`, JSON.stringify(data, null, 2).substring(0, 2000));
            console.error(`   Model used: gpt-4.1-mini`);
            console.error(`   Usage:`, data.usage ? JSON.stringify(data.usage) : 'not provided');
            console.error(`   Finish reason: ${finishReason}`);
            console.error(`   Refusal:`, refusal || 'null');
            console.error(`   Annotations:`, message.annotations || 'none');
            
            // Check if there are annotations that might explain the empty content
            if (message.annotations && Array.isArray(message.annotations) && message.annotations.length > 0) {
                console.error(`   Annotations details:`, JSON.stringify(message.annotations, null, 2));
            }
            
            throw new Error(`GPT-4.1-mini returned empty content - check finish_reason (${finishReason}), refusal, and annotations for details`);
        }
        
        const content = message.content.trim();
        console.log(`   ✅ [${requestId}] Success! Content length: ${content.length} chars`);
        console.log(`   Content preview: ${content.substring(0, 200)}...`);
        
        // Validate content length relative to token usage
        if (content.length > 0 && data.usage?.completion_tokens) {
            const avgCharsPerToken = content.length / data.usage.completion_tokens;
            console.log(`   Content efficiency: ${avgCharsPerToken.toFixed(2)} chars/token`);
            if (avgCharsPerToken < 2) {
                console.warn(`   ⚠️  [${requestId}] Very low chars/token ratio: ${avgCharsPerToken.toFixed(2)} (might indicate encoding issues or unusual content)`);
            }
            if (data.usage.completion_tokens >= maxTokens * 0.95) {
                console.warn(`   ⚠️  [${requestId}] Used ${data.usage.completion_tokens}/${maxTokens} tokens (95%+) - response may be truncated`);
            }
        }
        
        if (content.length === 0) {
            console.warn(`   ⚠️  [${requestId}] GPT API returned empty trimmed content. Raw content length: ${message.content.length}`);
            console.warn(`   Raw content:`, message.content);
            console.warn(`   Finish reason: ${finishReason}`);
        }
        
        if (data.usage) {
            console.log(`   Token usage:`, JSON.stringify(data.usage));
        }
        
        return content;

    } catch (error) {
        console.error(`\n❌ [${requestId}] GPT-4.1-mini API Call Error:`);
        console.error(`   Error name: ${error.name}`);
        console.error(`   Error message: ${error.message}`);
        console.error(`   Error stack:`, error.stack);
        
        // Handle timeout/abort errors
        if (error.name === 'AbortError') {
            console.error(`   ⚠️  Request timed out after ${timeoutMs}ms`);
            throw new Error('GPT API request timed out after 60 seconds');
        }

        // If it's a network error and we haven't exceeded retries, retry with exponential backoff
        if (retryCount < maxRetries && (error.message.includes('fetch') || error.message.includes('timeout'))) {
            const waitTime = Math.min(1000 * Math.pow(2, retryCount), 10000); // Cap at 10s
            console.log(`   ⏳ [${requestId}] Network error. Waiting ${(waitTime/1000).toFixed(1)}s before retry ${retryCount + 1}/${maxRetries}...`);
            await sleep(waitTime);
            return await callGPT(messages, maxTokens, retryCount + 1);
        }
        
        console.error(`   ❌ [${requestId}] Not retrying - max retries exceeded or non-retryable error`);
        throw error;
    }
}

/**
 * Synthesize results with strict fact-checking
 * @param {string} prompt - The synthesis prompt
 * @param {Object} data - Data to synthesize
 * @param {number} maxTokens - Maximum tokens (default: 4000)
 * @returns {Promise<string|null>} - Synthesized result or null on error
 */
async function synthesizeResults(prompt, data, maxTokens = 2000) {
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

