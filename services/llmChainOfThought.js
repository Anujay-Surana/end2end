/**
 * LLM Chain-of-Thought Service
 * 
 * Implements reasoning chains, self-critique, confidence scoring,
 * and structured output validation for higher quality LLM analysis
 */

const { callGPT, safeParseJSON } = require('./gptService');

/**
 * Execute chain-of-thought reasoning for complex analysis
 * 
 * @param {string} task - The analysis task
 * @param {Object} data - Data to analyze
 * @param {Object} options - Analysis options
 * @returns {Object} - Reasoned analysis with confidence score
 */
async function chainOfThoughtAnalysis(task, data, options = {}) {
    const {
        model = 'gpt-4o',
        temperature = 0.7,
        requireConfidence = true,
        allowSelfCritique = true
    } = options;
    
    // Step 1: Initial analysis with reasoning
    const reasoningPrompt = [{
        role: 'system',
        content: `You are analyzing: ${task}

IMPORTANT: Show your reasoning step-by-step before providing your final answer.

Format your response as:
REASONING:
- Step 1: [Your first reasoning step]
- Step 2: [Your second reasoning step]
- Step 3: [Your third reasoning step]
...

ANALYSIS:
[Your final analysis]

CONFIDENCE: [high|medium|low]
REASONING FOR CONFIDENCE: [Why are you confident/uncertain?]`
    }, {
        role: 'user',
        content: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    }];
    
    const initialAnalysis = await callGPT(reasoningPrompt, 2000);
    
    // Extract sections
    const reasoning = extractSection(initialAnalysis, 'REASONING:', 'ANALYSIS:');
    const analysis = extractSection(initialAnalysis, 'ANALYSIS:', 'CONFIDENCE:');
    const confidence = extractSection(initialAnalysis, 'CONFIDENCE:', 'REASONING FOR CONFIDENCE:');
    const confidenceReasoning = extractSection(initialAnalysis, 'REASONING FOR CONFIDENCE:', null);
    
    // Step 2: Self-critique (if enabled)
    let critique = null;
    let revisedAnalysis = analysis;
    
    if (allowSelfCritique && confidence !== 'high') {
        const critiquePrompt = [{
            role: 'system',
            content: `Review this analysis critically and identify potential flaws, missing information, or alternative interpretations.

Original Task: ${task}
Original Analysis: ${analysis}
Original Reasoning: ${reasoning}

Provide:
1. FLAWS: What could be wrong with this analysis?
2. MISSING: What information would improve this analysis?
3. ALTERNATIVES: Are there alternative interpretations?
4. REVISED: Should the analysis be revised? If yes, provide revised version.

Format as JSON:
{
  "flaws": ["flaw 1", "flaw 2"],
  "missing": ["missing info 1"],
  "alternatives": ["alternative interpretation 1"],
  "shouldRevise": true|false,
  "revisedAnalysis": "revised version if shouldRevise=true"
}`
        }];
        
        const critiqueResponse = await callGPT(critiquePrompt, 1000);
        
        try {
            critique = safeParseJSON(critiqueResponse);
            if (critique.shouldRevise && critique.revisedAnalysis) {
                revisedAnalysis = critique.revisedAnalysis;
                console.log(`  🔄 Analysis revised based on self-critique`);
            }
        } catch (e) {
            // Critique failed to parse, use original
        }
    }
    
    return {
        analysis: revisedAnalysis,
        reasoning: reasoning,
        confidence: confidence.toLowerCase().trim(),
        confidenceReasoning: confidenceReasoning,
        critique: critique,
        original: analysis !== revisedAnalysis ? analysis : null
    };
}

/**
 * Extract section from structured text
 */
function extractSection(text, startMarker, endMarker) {
    if (!text) return '';
    
    const startIdx = text.indexOf(startMarker);
    if (startIdx === -1) return '';
    
    const contentStart = startIdx + startMarker.length;
    
    if (!endMarker) {
        return text.substring(contentStart).trim();
    }
    
    const endIdx = text.indexOf(endMarker, contentStart);
    if (endIdx === -1) {
        return text.substring(contentStart).trim();
    }
    
    return text.substring(contentStart, endIdx).trim();
}

/**
 * Validate structured JSON output with retry
 * 
 * @param {Function} llmCall - Function that makes the LLM call
 * @param {Object} expectedSchema - Expected JSON schema
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Object} - Validated JSON object
 */
async function validateStructuredOutput(llmCall, expectedSchema, maxRetries = 2) {
    let attempt = 0;
    let lastError = null;
    
    while (attempt < maxRetries) {
        try {
            const response = await llmCall();
            const parsed = safeParseJSON(response);
            
            // Validate schema
            const validation = validateSchema(parsed, expectedSchema);
            if (validation.valid) {
                return { success: true, data: parsed, attempts: attempt + 1 };
            }
            
            // Schema validation failed
            lastError = validation.errors.join('; ');
            console.log(`  ⚠️  Schema validation failed (attempt ${attempt + 1}): ${lastError}`);
            
            if (attempt < maxRetries - 1) {
                // Retry with schema hints
                attempt++;
            } else {
                break;
            }
        } catch (e) {
            lastError = e.message;
            attempt++;
        }
    }
    
    return {
        success: false,
        data: null,
        error: lastError,
        attempts: attempt
    };
}

/**
 * Simple schema validation
 */
function validateSchema(data, schema) {
    const errors = [];
    
    for (const [key, type] of Object.entries(schema)) {
        if (!(key in data)) {
            errors.push(`Missing required field: ${key}`);
            continue;
        }
        
        const actualType = Array.isArray(data[key]) ? 'array' : typeof data[key];
        if (actualType !== type) {
            errors.push(`Field ${key} should be ${type}, got ${actualType}`);
        }
    }
    
    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Adaptive temperature selection based on task type
 * 
 * @param {string} taskType - Type of task
 * @returns {number} - Optimal temperature
 */
function selectTemperature(taskType) {
    const temperatureMap = {
        'extraction': 0.3,        // Factual extraction - low creativity needed
        'classification': 0.2,     // Classification - deterministic
        'analysis': 0.5,           // Analysis - moderate creativity
        'synthesis': 0.7,          // Synthesis - higher creativity
        'narrative': 0.8,          // Narrative generation - high creativity
        'creative': 0.9            // Creative tasks - very high
    };
    
    return temperatureMap[taskType] || 0.7;
}

/**
 * Multi-hypothesis generation for uncertain analysis
 * 
 * @param {string} question - Question to analyze
 * @param {Object} data - Available data
 * @returns {Array} - Array of alternative hypotheses
 */
async function generateAlternativeHypotheses(question, data) {
    const response = await callGPT([{
        role: 'system',
        content: `Generate 3 alternative hypotheses/interpretations for this question.

Question: ${question}

For each hypothesis, provide:
1. The hypothesis
2. Supporting evidence from data
3. Confidence level (high/medium/low)
4. What would confirm/refute this hypothesis

Return JSON array:
[
  {
    "hypothesis": "Hypothesis 1",
    "evidence": ["evidence 1", "evidence 2"],
    "confidence": "medium",
    "testable": "What would confirm/refute this?"
  }
]`
    }, {
        role: 'user',
        content: `Data:\n${JSON.stringify(data, null, 2)}`
    }], 1500);
    
    try {
        const hypotheses = safeParseJSON(response);
        return Array.isArray(hypotheses) ? hypotheses : [];
    } catch (e) {
        return [];
    }
}

module.exports = {
    chainOfThoughtAnalysis,
    validateStructuredOutput,
    selectTemperature,
    generateAlternativeHypotheses
};

