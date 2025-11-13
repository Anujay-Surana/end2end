const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const Parallel = require('parallel-web');
const fetch = require('node-fetch');
const VoiceConversationManager = require('./services/voiceConversation');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;

// ===== ENVIRONMENT VARIABLE VALIDATION =====
console.log('\n🔍 Validating environment variables...');

const requiredEnvVars = {
    'OPENAI_API_KEY': process.env.OPENAI_API_KEY,
    'PARALLEL_API_KEY': process.env.PARALLEL_API_KEY,
    'DEEPGRAM_API_KEY': process.env.DEEPGRAM_API_KEY
};

const missingVars = [];
const invalidVars = [];

for (const [name, value] of Object.entries(requiredEnvVars)) {
    if (!value) {
        missingVars.push(name);
    } else if (value.length < 10 || value === 'your_key_here' || value.includes('your_') || value.includes('_here')) {
        invalidVars.push(name);
    }
}

if (missingVars.length > 0) {
    console.error(`\n❌ Missing required environment variables: ${missingVars.join(', ')}`);
    console.error('Please add them to your .env file and restart the server.\n');
    process.exit(1);
}

if (invalidVars.length > 0) {
    console.error(`\n⚠️  Invalid/placeholder values detected: ${invalidVars.join(', ')}`);
    console.error('Please update these with your actual API keys in the .env file.\n');
    process.exit(1);
}

console.log('✅ All required environment variables are set\n');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Initialize Parallel AI client
const parallelClient = new Parallel({
    apiKey: process.env.PARALLEL_API_KEY
});

// Initialize Deepgram client with explicit options
let deepgram;
try {
    deepgram = createClient(DEEPGRAM_API_KEY, {
        global: {
            fetch: { options: { url: 'https://api.deepgram.com' } }
        }
    });
    console.log('✅ Deepgram client initialized');
    console.log(`   Using API endpoint: https://api.deepgram.com`);
} catch (error) {
    console.error('❌ Failed to initialize Deepgram client:', error.message);
    console.error('Please check your DEEPGRAM_API_KEY in the .env file.\n');
    process.exit(1);
}

// Store active meeting contexts (in-memory cache for fast access)
const activeMeetingContexts = new Map();

// Enable CORS for our frontend
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for large context

// Serve static files (frontend)
app.use(express.static(__dirname));

// TTS endpoint - uses OpenAI TTS
app.post('/api/tts', async (req, res) => {
    try {
        const { text } = req.body;

        if (!text || text.length === 0) {
            return res.status(400).json({ error: 'Text is required' });
        }

        console.log(`🔊 TTS request: ${text.substring(0, 50)}...`);

        // Call OpenAI TTS API
        const response = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'tts-1',
                voice: 'nova', // Warm, expressive female voice
                input: text.substring(0, 4096), // OpenAI limit
                speed: 1.1
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI TTS error: ${response.status}`);
        }

        // Stream audio back to client
        const audioBuffer = await response.arrayBuffer();
        res.set('Content-Type', 'audio/mpeg');
        res.send(Buffer.from(audioBuffer));

        console.log('✓ TTS generated successfully');

    } catch (error) {
        console.error('TTS error:', error);
        res.status(500).json({
            error: 'TTS generation failed',
            message: error.message
        });
    }
});

// Search endpoint - uses Parallel AI search
app.post('/api/parallel-search', async (req, res) => {
    try {
        const { objective, search_queries, mode, max_results, max_chars_per_result } = req.body;

        console.log(`🔍 Search request: ${objective?.substring(0, 60)}...`);

        const result = await parallelClient.beta.search({
            objective,
            search_queries,
            mode: mode || 'one-shot', // Use one-shot for comprehensive results
            max_results: max_results || 10,
            max_chars_per_result: max_chars_per_result || 3000 // Increased for richer context
        });

        console.log(`✓ Search completed: ${result.results?.length || 0} results`);
        res.json(result);
    } catch (error) {
        console.error('Parallel AI search error:', error);
        res.status(500).json({
            error: 'Search failed',
            message: error.message,
            results: [] // Return empty results on error
        });
    }
});

// Extract endpoint - extracts content from URLs
app.post('/api/parallel-extract', async (req, res) => {
    try {
        const { urls, objective, excerpts, fullContent } = req.body;

        console.log(`📄 Extract request for ${urls?.length || 0} URLs`);

        const result = await parallelClient.beta.extract({
            urls,
            objective,
            excerpts: excerpts !== false,
            fullContent: fullContent || false
        });

        console.log(`✓ Extract completed: ${result.results?.length || 0} results`);
        res.json(result);
    } catch (error) {
        console.error('Parallel AI extract error:', error);
        res.status(500).json({
            error: 'Extract failed',
            message: error.message,
            results: []
        });
    }
});

// Deep research endpoint - starts a research task
app.post('/api/parallel-research', async (req, res) => {
    try {
        const { input, task_spec, processor } = req.body;

        console.log(`🔬 Deep research request: ${input?.substring(0, 60)}...`);

        const taskRun = await parallelClient.taskRun.create({
            input,
            task_spec,
            processor: processor || 'base'
        });

        console.log(`✓ Research task created: ${taskRun.run_id}`);
        res.json(taskRun);
    } catch (error) {
        console.error('Parallel AI research error:', error);
        res.status(500).json({
            error: 'Research task failed',
            message: error.message
        });
    }
});

// ===== GPT HELPER FUNCTIONS =====

async function callGPT(messages, maxTokens = 1000) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages,
            temperature: 0.7,
            max_tokens: maxTokens
        })
    });

    if (!response.ok) {
        throw new Error(`GPT API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
}

async function craftSearchQueries(context) {
    try {
        const result = await callGPT([{
            role: 'system',
            content: 'Generate EXACTLY 3 highly specific web search queries. Return ONLY a JSON array. Example: ["query 1", "query 2", "query 3"]'
        }, {
            role: 'user',
            content: context
        }], 200);

        const queries = JSON.parse(result);
        return Array.isArray(queries) ? queries.slice(0, 3) : [];
    } catch (error) {
        console.error('Error crafting queries:', error);
        return [];
    }
}

async function synthesizeResults(prompt, data, maxTokens = 500) {
    try {
        const result = await callGPT([{
            role: 'system',
            content: `You are an executive briefing expert. Extract meaningful, verified information from the provided data.

Rules:
1. ONLY include facts directly supported by the data provided
2. Be specific and concrete - include numbers, dates, companies, titles, achievements
3. Each fact should be complete and clear (15-80 words is ideal)
4. Skip generic statements like "experienced professional" or "works in tech"
5. Focus on recent activities, achievements, roles, and specific expertise
6. If data quality is poor, return fewer high-quality facts rather than padding with fluff
7. Return information that would be genuinely useful in a business meeting context`
        }, {
            role: 'user',
            content: `${prompt}\n\nData:\n${JSON.stringify(data).substring(0, 12000)}`
        }], maxTokens);

        return result;
    } catch (error) {
        console.error('Error synthesizing:', error);
        return null;
    }
}

// ===== MEETING PREP ENDPOINT =====

app.post('/api/prep-meeting', async (req, res) => {
    try {
        const { meeting, attendees, emails, files } = req.body;

        console.log(`\n📋 Preparing brief for: ${meeting.summary}`);

        const brief = {
            summary: '',
            attendees: [],
            companies: [],
            actionItems: [],
            context: ''
        };

        // Research attendees - prioritize local context, then web
        const attendeePromises = attendees.slice(0, 6).map(async (att) => {
            const name = att.displayName || att.email.split('@')[0];
            const domain = att.email.split('@')[1];
            const company = domain.split('.')[0];

            // Skip resource calendars (conference rooms)
            if (att.email.includes('@resource.calendar.google.com')) {
                console.log(`  ⏭️  Skipping resource calendar: ${name}`);
                return null;
            }

            console.log(`  🔍 Researching: ${name} (${att.email})`);

            let keyFacts = [];
            let title = company;
            let source = 'local'; // Track data source

            // STEP 1: Extract info from local context (emails)
            const attendeeEmails = emails ? emails.filter(e =>
                e.from?.toLowerCase().includes(att.email.toLowerCase()) ||
                e.snippet?.toLowerCase().includes(name.toLowerCase())
            ) : [];

            if (attendeeEmails.length > 0) {
                console.log(`    📧 Found ${attendeeEmails.length} emails from ${name}`);
                const localSynthesis = await synthesizeResults(
                    `Extract key professional information about ${name} (${att.email}) from these emails for meeting "${meeting.summary}".

Focus on:
- Their role or title if mentioned
- Projects or work they're involved in
- Expertise areas or responsibilities
- Any context relevant to this meeting

Return ONLY a JSON array of 2-4 specific facts. Only include facts directly stated in the emails.

Example: ["Leading the Kordn8 MVP development mentioned in Nov 9 email", "Requested UBM agenda document for this meeting"]

If emails don't contain professional info, return empty array: []`,
                    attendeeEmails.slice(0, 10),
                    400
                );

                try {
                    let clean = localSynthesis?.replace(/```json/g, '').replace(/```/g, '').trim();
                    const parsed = JSON.parse(clean);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        keyFacts = parsed.filter(f => f && f.length > 10);
                        console.log(`    ✓ Extracted ${keyFacts.length} facts from emails`);
                    }
                } catch (e) {
                    console.log(`    ⚠️  No structured info from emails`);
                }
            }

            // STEP 2: Always do web search to supplement
            console.log(`    🌐 Supplementing with web search...`);

            // Craft queries with email domain for disambiguation
            const queries = await craftSearchQueries(
                `${name} ${att.email} ${domain}. Find current role and professional background. Include email domain to find the RIGHT person.`
            );

            if (queries.length === 0) {
                queries.push(
                    `"${name}" ${domain} LinkedIn`,
                    `"${name}" ${att.email}`,
                    `${name} ${company}`
                );
            }

            const searchResult = await parallelClient.beta.search({
                objective: `Find professional information about ${name} at ${domain}`,
                search_queries: queries.slice(0, 3),
                mode: 'one-shot',
                max_results: 8,
                max_chars_per_result: 2500
            });

            console.log(`    ✓ Found ${searchResult.results?.length || 0} web results`);

            if (searchResult.results && searchResult.results.length > 0) {
                // Adjust confidence based on whether we have local context
                const hasLocalContext = keyFacts.length > 0;

                // Check if results mention the email domain
                const domainMentioned = searchResult.results.some(r =>
                    r.url?.includes(domain) ||
                    r.excerpts?.some(ex => ex.toLowerCase().includes(domain.toLowerCase()))
                );

                const confidenceLevel = hasLocalContext ? 'strict' : (domainMentioned ? 'moderate' : 'lenient');
                console.log(`    🎯 Confidence level: ${confidenceLevel}`);

                let confidencePrompt = '';
                if (confidenceLevel === 'strict') {
                    confidencePrompt = `CRITICAL: Only include info if you're CONFIDENT it's about THIS specific person at ${domain}. If unsure, return empty array: []`;
                } else if (confidenceLevel === 'moderate') {
                    confidencePrompt = `Extract info about ${name} from ${domain}. Prioritize results mentioning ${domain}. If results seem to be about a different person with same name, return empty array: []`;
                } else {
                    confidencePrompt = `Extract professional info about ${name}. The email is ${att.email}. Include basic professional info found. If results are clearly about a different person, return empty array: []`;
                }

                const webSynthesis = await synthesizeResults(
                    `${confidencePrompt}

Return JSON array of 2-4 specific, professional facts.

Example format: ["Software Engineer at ${company}", "Previously worked at X", "Expertise in Y"]`,
                    searchResult.results,
                    600
                );

                try {
                    let clean = webSynthesis?.replace(/```json/g, '').replace(/```/g, '').trim();
                    const parsed = JSON.parse(clean);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        // Add web facts
                        const webFacts = parsed.filter(f => f && f.length > 10);
                        keyFacts.push(...webFacts);
                        source = hasLocalContext ? 'local+web' : 'web';
                        console.log(`    ✓ Added ${webFacts.length} facts from web`);
                    } else {
                        console.log(`    ⚠️  GPT returned empty array (low confidence)`);
                    }
                } catch (e) {
                    console.log(`    ⚠️  Failed to parse web results: ${e.message}`);
                }
            } else {
                console.log(`    ⚠️  No web results found`);
            }

            // Try to extract title from web results
            if (searchResult.results?.[0]?.excerpts) {
                const excerpt = searchResult.results[0].excerpts.join(' ');
                const titleMatch = excerpt.match(new RegExp(`${name}[^,.]*(CEO|CTO|VP|Director|Head|Manager|Engineer|Designer|Lead|Founder|Partner|Analyst|Specialist|Coordinator)[^,.]{0,30}`, 'i'));
                if (titleMatch && excerpt.includes(domain)) {
                    title = titleMatch[0].trim();
                }
            }

            // Limit to top facts
            keyFacts = keyFacts.slice(0, 4);

            console.log(`  ✓ ${name}: ${keyFacts.length} facts (source: ${source})`);

            return {
                name: name,
                email: att.email,
                title: title,
                keyFacts: keyFacts,
                dataSource: source
            };
        });

        // Keep all attendees
        brief.attendees = (await Promise.all(attendeePromises)).filter(a => a !== null);

        console.log(`\n  📊 Generating meeting summary...`);

        // Generate executive summary with more context
        const summaryData = {
            meeting: {
                title: meeting.summary,
                description: meeting.description,
                attendees: brief.attendees.map(a => ({ name: a.name, title: a.title, facts: a.keyFacts }))
            },
            recentEmails: emails?.slice(0, 5).map(e => ({
                subject: e.subject,
                snippet: e.snippet
            })),
            files: files?.slice(0, 3).map(f => ({ name: f.name }))
        };

        brief.summary = await synthesizeResults(
            `Write 2-3 concise sentences summarizing this meeting's context and purpose.

Include:
- Meeting topic and objective
- Key participants and their relevance
- Important context from emails/recent activity

Be specific and informative. Focus on what matters for preparation.`,
            summaryData,
            400
        );

        // Action items will be generated AFTER all context is gathered

        // Generate email analysis - meeting-specific
        console.log(`  📧 Analyzing email threads for meeting context...`);
        let emailAnalysis = '';
        if (emails && emails.length > 0) {
            const emailSummary = await synthesizeResults(
                `You are preparing for a meeting titled "${meeting.summary}". Analyze these email threads and extract ONLY information directly relevant to THIS SPECIFIC MEETING.

Focus on:
- Discussions, decisions, or context about the meeting topic
- Action items or deliverables mentioned that relate to this meeting
- Important context shared between attendees about the meeting subject
- Any preparation, documents, or topics mentioned for discussion

IGNORE:
- General company updates unrelated to this meeting
- Event invitations or social activities
- Administrative emails (unless directly about this meeting)
- Generic community announcements

Return a 3-5 sentence paragraph. If emails don't contain relevant meeting context, say "No directly relevant email discussions found about this meeting topic."

Be specific - quote or reference actual email content when relevant.`,
                emails.slice(0, 15),
                600
            );
            emailAnalysis = emailSummary || 'No email activity found.';
        }

        // Generate document/file analysis - meeting-specific with content
        console.log(`  📄 Analyzing document content for meeting relevance...`);
        let documentAnalysis = '';
        if (files && files.length > 0) {
            // Filter files with content
            const filesWithContent = files.filter(f => f.content && f.content.length > 100);

            if (filesWithContent.length > 0) {
                const docSummary = await synthesizeResults(
                    `You are preparing for a meeting titled "${meeting.summary}".

Analyze the ACTUAL CONTENT of these documents and extract insights relevant to THIS SPECIFIC MEETING.

For each document:
- Summarize key points that relate to the meeting topic
- Quote or reference specific sections that are relevant
- Explain how this content connects to meeting objectives
- Note any data, decisions, or action items mentioned

IGNORE documents unrelated to the meeting topic.

Return a 4-7 sentence paragraph with SPECIFIC insights from the document content (not vague descriptions).`,
                    filesWithContent.map(f => ({
                        name: f.name,
                        content: f.content.substring(0, 15000), // First 15k chars per doc
                        mimeType: f.mimeType
                    })),
                    800
                );
                documentAnalysis = docSummary || 'No meeting-relevant content found in documents.';
            } else if (files.length > 0) {
                // Fallback to title-based analysis if no content
                documentAnalysis = `Found ${files.length} documents: ${files.map(f => f.name).slice(0, 3).join(', ')}. Unable to access content for detailed analysis.`;
            }
        }

        // Generate company/context research - extract from LOCAL context only
        console.log(`  🏢 Analyzing company context from local sources...`);
        let companyResearch = '';

        // Extract company names mentioned in emails and documents
        const localCompanyContext = [];
        if (emails && emails.length > 0) {
            emails.slice(0, 10).forEach(e => {
                const text = `${e.subject} ${e.body || e.snippet}`.toLowerCase();
                // Look for common company indicators
                if (text.includes('kordn8')) localCompanyContext.push('Kordn8');
            });
        }

        if (files && files.length > 0) {
            files.forEach(f => {
                if (f.content) {
                    const text = f.content.toLowerCase();
                    if (text.includes('kordn8')) localCompanyContext.push('Kordn8');
                }
            });
        }

        // If we found company mentions in local context, extract insights
        if (localCompanyContext.length > 0 || (emails && emails.length > 0)) {
            const uniqueCompanies = [...new Set(localCompanyContext)];
            console.log(`  📊 Found company mentions: ${uniqueCompanies.join(', ') || 'extracting from context'}`);

            const companyContext = await synthesizeResults(
                `Extract any company-related context, business updates, or organizational information mentioned in these emails and documents for meeting "${meeting.summary}".

Focus on:
- Company goals, objectives, or strategy mentioned
- Product or service developments discussed
- Team changes, hiring, or organizational updates
- Business metrics, milestones, or challenges mentioned
- Any competitive or market context discussed

Return a 2-4 sentence paragraph. If no substantive company context is found, return "No specific company developments discussed in available context."

Be specific and reference actual content - avoid speculation.`,
                {
                    emails: emails?.slice(0, 10).map(e => ({ subject: e.subject, body: e.body || e.snippet })),
                    documents: files?.filter(f => f.content).slice(0, 3).map(f => ({ name: f.name, excerpt: f.content?.substring(0, 2000) })),
                    meetingTitle: meeting.summary
                },
                500
            );

            companyResearch = companyContext || 'No specific company developments discussed in available context.';
        } else {
            companyResearch = 'No company context available from emails or documents.';
        }

        // Generate strategic recommendations - deeply contextualized
        console.log(`  💡 Generating meeting-specific recommendations...`);
        const recommendations = await synthesizeResults(
            `You are preparing for the meeting: "${meeting.summary}"

Based on the LOCAL CONTEXT (emails, documents, attendee info), provide 3-5 strategic recommendations for THIS SPECIFIC MEETING.

Context available:
- Attendees: ${brief.attendees.map(a => `${a.name} (${a.keyFacts.join('; ')})`).join(' | ')}
- Email discussions: ${emailAnalysis}
- Documents: ${documentAnalysis}
- Company context: ${companyResearch}

Each recommendation should:
1. Reference SPECIFIC information from the context above
2. Be actionable for THIS meeting
3. Connect multiple data points (e.g., "Based on email X and document Y, suggest Z")
4. Be 25-70 words

Example format:
["Based on Akshay's Nov 9 email sharing the UBM agenda document and the 'Kordn8 MVP Functions Detailed Report', prepare specific questions about MVP limitations and proposed solutions for the Kordn8 discussion", "Reference the 'Short Term User Stickiness' document when discussing retention strategies - it appears directly relevant to meeting objectives"]

Return ONLY a JSON array. If insufficient context for meaningful recommendations, return fewer but high-quality ones.`,
            {
                meetingTitle: meeting.summary,
                emailContext: emailAnalysis,
                docContext: documentAnalysis,
                attendeeContext: brief.attendees.map(a => ({ name: a.name, facts: a.keyFacts, source: a.dataSource }))
            },
            900
        );

        let parsedRecommendations = [];
        try {
            let cleanRecs = recommendations
                .replace(/```json/g, '')
                .replace(/```/g, '')
                .trim();
            const parsed = JSON.parse(cleanRecs);
            parsedRecommendations = Array.isArray(parsed) ? parsed.slice(0, 5) : [];
        } catch (e) {
            console.error(`  ⚠️  Failed to parse recommendations:`, e.message);
            parsedRecommendations = recommendations ?
                recommendations.split(/[\n•\-]/)
                    .map(r => r.trim().replace(/^[\d\.\)]+\s*/, ''))
                    .filter(r => r && r.length > 20)
                    .slice(0, 5) : [];
        }

        // Generate action items LAST with full context
        console.log(`  📝 Generating action items with full context...`);
        const actionPrompt = `You are preparing for the meeting: "${meeting.summary}"

Based on ALL the context gathered below, suggest 4-6 HIGH-QUALITY, STRATEGIC action items to prepare effectively for THIS SPECIFIC MEETING.

FULL CONTEXT:
- Attendees: ${brief.attendees.map(a => `${a.name} (${a.keyFacts.join('; ')})`).join(' | ')}
- Email discussions: ${emailAnalysis}
- Document insights: ${documentAnalysis}
- Company context: ${companyResearch}
- Strategic recommendations: ${parsedRecommendations.join(' | ')}

CRITICAL INSTRUCTIONS:
1. Each action item must be DIRECTLY relevant to "${meeting.summary}" - NOT other meetings or calendar events
2. Reference SPECIFIC documents, emails, or insights from the context above
3. Make items substantive and detailed (20-60 words each)
4. Focus on what will make THIS meeting successful
5. Connect action items to the actual context provided (e.g., "Review the 'Kordn8 MVP Functions' document mentioned in emails")
6. Avoid generic suggestions - be concrete and meeting-specific

Example format:
["Review the 'Kordn8 MVP Functions Detailed Report' shared by Akshay on Nov 9, paying special attention to current limitations and gaps that need addressing, and prepare 2-3 specific questions about implementation priorities", "Based on the financial coordination emails with Continuum Labs, prepare a brief update on payment status and any outstanding invoicing questions that may come up in the meeting"]

Return ONLY a JSON array of 4-6 action items. Each should demonstrate understanding of the meeting's context and purpose.`;

        const actionResult = await synthesizeResults(
            actionPrompt,
            {
                meetingTitle: meeting.summary,
                attendees: brief.attendees,
                emailAnalysis,
                documentAnalysis,
                companyResearch,
                recommendations: parsedRecommendations
            },
            700
        );

        let parsedActionItems = [];
        try {
            let cleanAction = actionResult
                .replace(/```json/g, '')
                .replace(/```/g, '')
                .trim();
            const parsed = JSON.parse(cleanAction);
            parsedActionItems = Array.isArray(parsed) ? parsed
                .filter(item => item && typeof item === 'string' && item.length > 15)
                .slice(0, 6) : [];
        } catch (e) {
            console.error(`  ⚠️  Failed to parse action items:`, e.message);
            // Fallback parsing
            parsedActionItems = actionResult ?
                actionResult
                    .split(/[\n•\-]/)
                    .map(a => a.trim().replace(/^[\d\.\)]+\s*/, ''))
                    .filter(a => a && a.length > 15)
                    .slice(0, 6) : [];
        }

        // Assemble comprehensive brief
        brief.emailAnalysis = emailAnalysis;
        brief.documentAnalysis = documentAnalysis;
        brief.companyResearch = companyResearch;
        brief.recommendations = parsedRecommendations;
        brief.actionItems = parsedActionItems;

        console.log(`✓ Comprehensive brief generated with ${brief.attendees.length} attendees`);
        res.json(brief);

    } catch (error) {
        console.error('Brief generation error:', error);
        res.status(500).json({
            error: 'Failed to generate brief',
            message: error.message
        });
    }
});

// ===== REAL-TIME MEETING ASSISTANT WEBSOCKET =====

wss.on('connection', (ws) => {
    console.log('🎤 New meeting assistant connection');

    let deepgramConnection = null;
    let deepgramState = 'not_initialized'; // not_initialized, connecting, ready, error, closed
    let meetingContext = null;
    let transcriptBuffer = [];
    let audioBuffer = []; // Buffer audio until Deepgram is ready
    let lastAnalysisTime = Date.now();
    let userEmail = null;
    let speakerMap = new Map();
    let keepAliveInterval = null;
    let connectionTimeout = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 3;
    const MAX_AUDIO_BUFFER_SIZE = 20; // Buffer max 20 chunks (~10 seconds at 500ms chunks)

    // Suggestion deduplication tracking
    const recentSuggestionHashes = new Set();
    const SUGGESTION_DEDUP_WINDOW_MS = 60000; // 60 seconds

    // Function to initialize Deepgram connection
    function initializeDeepgram() {
        if (deepgramConnection) {
            try {
                deepgramConnection.finish();
            } catch (e) {
                console.error('Error closing existing Deepgram connection:', e);
            }
        }

        deepgramState = 'connecting';
        console.log('🔌 Initializing Deepgram connection...');

        try {
            deepgramConnection = deepgram.listen.live({
                model: 'nova-2',
                language: 'en',
                encoding: 'linear16', // Raw PCM audio (Int16)
                sample_rate: 16000,
                channels: 1,
                smart_format: true,
                punctuate: false, // Reduces latency (no look-ahead)
                diarize: true,
                interim_results: true, // Enable for <300ms latency
                vad_events: true, // Voice activity detection
                utterance_end_ms: 1000,
                endpointing: 300
            });

            // Set connection timeout
            connectionTimeout = setTimeout(() => {
                if (deepgramState === 'connecting') {
                    console.error('⏱️  Deepgram connection timeout');
                    handleDeepgramError(new Error('Connection timeout'));
                }
            }, 10000);

            deepgramConnection.on('open', () => {
                clearTimeout(connectionTimeout);
                deepgramState = 'ready';
                reconnectAttempts = 0;
                console.log('✓ Deepgram connection opened');

                // Flush buffered audio
                if (audioBuffer.length > 0) {
                    console.log(`📤 Flushing ${audioBuffer.length} buffered audio chunks`);
                    audioBuffer.forEach(chunk => {
                        if (deepgramConnection.getReadyState() === 1) {
                            deepgramConnection.send(chunk);
                        }
                    });
                    audioBuffer = [];
                }

                // Start keep-alive
                startKeepAlive();

                // Notify frontend
                ws.send(JSON.stringify({
                    type: 'deepgram_ready',
                    message: 'Transcription service ready'
                }));
            });

            deepgramConnection.on('Results', async (data) => {
                const transcript = data.channel?.alternatives?.[0];
                if (!transcript || !transcript.transcript) return;

                const text = transcript.transcript;
                const words = transcript.words || [];
                const confidence = transcript.confidence;

                // Extract speaker info
                let speaker = 'Unknown';
                let speakerId = null;
                if (words.length > 0 && words[0].speaker !== undefined) {
                    speakerId = words[0].speaker;
                    // Use mapped name if available, otherwise generic "Speaker X"
                    speaker = speakerMap.get(speakerId) || `Speaker ${speakerId}`;
                }

                // Detect if this is the user speaking
                // Check both mapped name and if speakerMap indicates this is the user
                const isUser = (speakerMap.get(speakerId) === 'You') ||
                              (userEmail && speaker.toLowerCase().includes(userEmail.split('@')[0].toLowerCase()));

                // Send transcription to frontend
                ws.send(JSON.stringify({
                    type: 'transcript',
                    speaker,
                    text,
                    confidence,
                    isUser,
                    speakerId, // Include raw speaker ID for mapping
                    timestamp: Date.now()
                }));

                // Add to buffer for analysis (circular buffer)
                transcriptBuffer.push({ speaker, text, isUser, timestamp: Date.now() });
                if (transcriptBuffer.length > 30) {
                    transcriptBuffer = transcriptBuffer.slice(-30);
                }

                // Analyze every ~5 seconds or when buffer has 5+ utterances
                const now = Date.now();
                if ((now - lastAnalysisTime > 5000 && transcriptBuffer.length > 0) ||
                    transcriptBuffer.length >= 5) {

                    lastAnalysisTime = now;

                    // Analyze transcript with AI (async, don't block)
                    analyzeTranscript(
                        transcriptBuffer.slice(-10),
                        meetingContext,
                        ws,
                        recentSuggestionHashes
                    ).catch(err => {
                        console.error('Analysis error:', err);
                    });
                }

                // Reset keep-alive timer (we have activity)
                startKeepAlive();
            });

            deepgramConnection.on('error', (err) => {
                console.error('Deepgram error:', err);
                handleDeepgramError(err);
            });

            deepgramConnection.on('close', () => {
                console.log('Deepgram connection closed');
                clearTimeout(connectionTimeout);
                stopKeepAlive();

                if (deepgramState !== 'closed' && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    console.log(`🔄 Attempting to reconnect (${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
                    reconnectAttempts++;
                    setTimeout(() => {
                        if (deepgramState !== 'closed') {
                            initializeDeepgram();
                        }
                    }, Math.min(1000 * Math.pow(2, reconnectAttempts), 8000));
                } else {
                    deepgramState = 'closed';
                }
            });

        } catch (error) {
            console.error('Failed to create Deepgram connection:', error);
            handleDeepgramError(error);
        }
    }

    function handleDeepgramError(err) {
        clearTimeout(connectionTimeout);
        stopKeepAlive();
        deepgramState = 'error';

        console.error('Deepgram error details:', err.message || err);

        ws.send(JSON.stringify({
            type: 'error',
            message: 'Transcription service error. Please try again.',
            canRetry: reconnectAttempts < MAX_RECONNECT_ATTEMPTS
        }));

        // Auto-retry if under limit
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            setTimeout(() => {
                if (deepgramState !== 'closed') {
                    initializeDeepgram();
                }
            }, Math.min(1000 * Math.pow(2, reconnectAttempts), 8000));
        }
    }

    function startKeepAlive() {
        stopKeepAlive();
        keepAliveInterval = setInterval(() => {
            if (deepgramConnection && deepgramConnection.getReadyState() === 1) {
                try {
                    deepgramConnection.keepAlive();
                    console.log('💓 Keep-alive sent to Deepgram');
                } catch (e) {
                    console.error('Keep-alive failed:', e);
                }
            }
        }, 5000);
    }

    function stopKeepAlive() {
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
    }

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            // Initialize meeting context
            if (data.type === 'init') {
                console.log(`📋 Initializing meeting context for: ${data.meetingId}`);
                meetingContext = data.context;
                userEmail = data.userEmail;

                // Don't auto-map speakers - wait for user to map them
                // Speaker map starts empty, will be populated via 'map_speaker' messages

                // Store in global cache
                activeMeetingContexts.set(data.meetingId, meetingContext);

                // Don't initialize Deepgram yet - wait for first audio
                ws.send(JSON.stringify({
                    type: 'ready',
                    message: 'Meeting assistant initialized. Start speaking to begin transcription.'
                }));
            }

            // Map speaker ID to name
            else if (data.type === 'map_speaker') {
                const { speakerId, name } = data;
                speakerMap.set(speakerId, name);
                console.log(`👤 Mapped Speaker ${speakerId} → ${name}`);

                ws.send(JSON.stringify({
                    type: 'speaker_mapped',
                    speakerId,
                    name
                }));
            }

            // Forward audio to Deepgram (lazy initialize on first audio)
            else if (data.type === 'audio') {
                const audioChunk = Buffer.from(data.audio, 'base64');

                // Initialize Deepgram on first audio packet
                if (deepgramState === 'not_initialized') {
                    initializeDeepgram();
                }

                // Buffer audio if Deepgram isn't ready yet
                if (deepgramState === 'connecting' || deepgramState === 'error') {
                    if (audioBuffer.length < MAX_AUDIO_BUFFER_SIZE) {
                        audioBuffer.push(audioChunk);
                        console.log(`📦 Buffering audio (${audioBuffer.length}/${MAX_AUDIO_BUFFER_SIZE})`);
                    } else {
                        // Buffer full, drop oldest
                        audioBuffer.shift();
                        audioBuffer.push(audioChunk);
                    }
                }
                // Send immediately if ready
                else if (deepgramState === 'ready' && deepgramConnection) {
                    if (deepgramConnection.getReadyState() === 1) {
                        deepgramConnection.send(audioChunk);
                        startKeepAlive(); // Reset keep-alive timer
                    } else {
                        // Connection closed unexpectedly
                        console.warn('⚠️  Deepgram not ready, buffering...');
                        audioBuffer.push(audioChunk);
                        if (deepgramState === 'ready') {
                            deepgramState = 'connecting';
                            initializeDeepgram();
                        }
                    }
                }
            }

            // Interactive Prep: Initialize
            else if (data.type === 'interactive_prep_init') {
                console.log('💬 Interactive prep initialized');
                ws.interactivePrepContext = data.meetingBrief;
                ws.isInteractiveMode = true;
                ws.interactiveConversation = [];
                ws.interactiveDeepgram = null;
                ws.interactiveVoiceBuffer = '';
            }

            // Interactive Prep: Text message
            else if (data.type === 'interactive_message') {
                if (!ws.isInteractiveMode || !ws.interactivePrepContext) {
                    ws.send(JSON.stringify({
                        type: 'interactive_error',
                        message: 'Interactive prep not initialized'
                    }));
                    return;
                }

                console.log('💬 User message:', data.message);

                // Process message with GPT-4o and web search
                try {
                    const response = await handleInteractiveMessage(
                        data.message,
                        ws.interactivePrepContext,
                        data.conversationHistory || []
                    );

                    ws.send(JSON.stringify({
                        type: 'interactive_response',
                        message: response.message,
                        toolCall: response.toolCall || null
                    }));
                } catch (error) {
                    console.error('Error processing interactive message:', error);
                    ws.send(JSON.stringify({
                        type: 'interactive_error',
                        message: 'Failed to process message: ' + error.message
                    }));
                }
            }

            // Interactive Prep: Voice start
            else if (data.type === 'interactive_voice_start') {
                console.log('🎤 Interactive voice started');

                // Initialize Deepgram for voice transcription
                const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
                const dgConnection = deepgram.listen.live({
                    model: 'nova-2',
                    language: 'en',
                    smart_format: true,
                    interim_results: true,
                    utterance_end_ms: 1500,
                    encoding: 'linear16',
                    sample_rate: 16000
                });

                dgConnection.on('open', () => {
                    console.log('✅ Interactive Deepgram connected');
                });

                dgConnection.on('Results', (data) => {
                    const transcript = data.channel?.alternatives?.[0]?.transcript;
                    if (transcript && data.is_final) {
                        ws.interactiveVoiceBuffer += transcript + ' ';
                        console.log('🎤 Voice transcript:', transcript);
                    }
                });

                dgConnection.on('UtteranceEnd', async () => {
                    if (ws.interactiveVoiceBuffer.trim()) {
                        const userMessage = ws.interactiveVoiceBuffer.trim();
                        ws.interactiveVoiceBuffer = '';

                        console.log('💬 Voice message complete:', userMessage);

                        // Process as text message
                        try {
                            const response = await handleInteractiveMessage(
                                userMessage,
                                ws.interactivePrepContext,
                                ws.interactiveConversation || []
                            );

                            ws.send(JSON.stringify({
                                type: 'interactive_response',
                                message: response.message,
                                toolCall: response.toolCall || null
                            }));
                        } catch (error) {
                            console.error('Error processing voice message:', error);
                            ws.send(JSON.stringify({
                                type: 'interactive_error',
                                message: 'Failed to process voice: ' + error.message
                            }));
                        }
                    }
                });

                dgConnection.on('error', (error) => {
                    console.error('Interactive Deepgram error:', error);
                });

                ws.interactiveDeepgram = dgConnection;
            }

            // Interactive Prep: Voice audio data
            else if (data.type === 'interactive_voice_data') {
                if (ws.interactiveDeepgram) {
                    const audioChunk = Buffer.from(new Int16Array(data.audio).buffer);
                    if (ws.interactiveDeepgram.getReadyState() === 1) {
                        ws.interactiveDeepgram.send(audioChunk);
                    }
                }
            }

            // Interactive Prep: Voice stop
            else if (data.type === 'interactive_voice_stop') {
                console.log('🎤 Interactive voice stopped');
                if (ws.interactiveDeepgram) {
                    ws.interactiveDeepgram.finish();
                    ws.interactiveDeepgram = null;
                }
                ws.interactiveVoiceBuffer = '';
            }

            // Voice Conversation: Start conversational voice mode
            else if (data.type === 'voice_conversation_start') {
                console.log('💬 Starting voice conversation mode');

                if (!ws.interactivePrepContext) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Interactive prep context not initialized'
                    }));
                    return;
                }

                // Create voice conversation manager
                ws.voiceConversationManager = new VoiceConversationManager(
                    ws.interactivePrepContext,
                    userEmail,
                    parallelClient,
                    OPENAI_API_KEY
                );

                // Connect the manager to the WebSocket
                await ws.voiceConversationManager.connect(ws);

                console.log('✅ Voice conversation initialized');
            }

            // Voice Conversation: Audio data streaming
            else if (data.type === 'voice_conversation_audio') {
                if (ws.voiceConversationManager) {
                    const audioChunk = Buffer.from(data.audio, 'base64');
                    ws.voiceConversationManager.sendAudio(audioChunk);
                } else {
                    console.warn('⚠️  Voice conversation not initialized');
                }
            }

            // Voice Conversation: Stop
            else if (data.type === 'voice_conversation_stop') {
                console.log('🛑 Stopping voice conversation');
                if (ws.voiceConversationManager) {
                    ws.voiceConversationManager.disconnect();
                    ws.voiceConversationManager = null;
                }
            }

            // Stop meeting
            else if (data.type === 'stop') {
                deepgramState = 'closed';
                stopKeepAlive();
                clearTimeout(connectionTimeout);

                if (deepgramConnection) {
                    try {
                        deepgramConnection.finish();
                    } catch (e) {
                        console.error('Error finishing Deepgram:', e);
                    }
                    deepgramConnection = null;
                }

                // Clean up interactive mode if active
                if (ws.interactiveDeepgram) {
                    ws.interactiveDeepgram.finish();
                    ws.interactiveDeepgram = null;
                }
                ws.isInteractiveMode = false;

                console.log('Meeting assistant stopped');
            }

        } catch (error) {
            console.error('WebSocket message error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });

    ws.on('close', () => {
        console.log('Meeting assistant disconnected');
        if (deepgramConnection) {
            deepgramConnection.finish();
        }

        // Clean up voice conversation manager
        if (ws.voiceConversationManager) {
            ws.voiceConversationManager.disconnect();
            ws.voiceConversationManager = null;
        }

        // Clean up interactive mode
        if (ws.interactiveDeepgram) {
            ws.interactiveDeepgram.finish();
            ws.interactiveDeepgram = null;
        }

        stopKeepAlive();
    });
});

// Helper: Create hash for suggestion deduplication
function hashSuggestion(suggestion) {
    // Create a simple hash from message content (case-insensitive, normalized)
    const normalized = suggestion.message.toLowerCase().replace(/[^\w\s]/g, '').trim();
    return normalized.substring(0, 100); // Use first 100 chars as hash
}

// Helper: Check if suggestion is generic/low-quality
function isGenericSuggestion(message) {
    const genericPatterns = [
        /seems? (unsure|uncertain|confused)/i,
        /clarify (who|what|roles|identity)/i,
        /expressed? uncertainty/i,
        /using ['"](i think|maybe)['"]/i
    ];
    return genericPatterns.some(pattern => pattern.test(message));
}

// Analyze transcript and provide real-time suggestions
async function analyzeTranscript(buffer, context, ws, recentSuggestionHashes) {
    if (buffer.length === 0) return;

    const recentText = buffer.map(b => `${b.speaker}: ${b.text}`).join('\n');
    const userStatements = buffer.filter(b => b.isUser).map(b => b.text).join(' ');

    try {
        // Enhanced GPT-4o analysis with anti-spam instructions
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: [{
                    role: 'system',
                    content: `You are a real-time meeting assistant. Analyze the conversation and provide SPECIFIC, ACTIONABLE feedback.

CRITICAL QUALITY RULES:
1. Only suggest if you have CONCRETE, SPECIFIC information to share
2. NO generic observations like "seems uncertain" or "clarify identity"
3. NO obvious statements (e.g., "India is second most populous" when user just said it)
4. Focus on HIGH-VALUE suggestions: corrections, non-obvious context, specific facts
5. Maximum 2-3 suggestions per analysis - quality over quantity

Your job:
1. Detect MEANINGFUL uncertainty that needs verification (not casual speech)
2. Fact-check specific claims using meeting context
3. Suggest SPECIFIC, relevant information from context that user wouldn't know
4. Correct factual errors with sources

Meeting Context:
${JSON.stringify(context).substring(0, 5000)}

Return JSON with this structure:
{
  "suggestions": [{"type": "uncertainty|fact|correction|context", "message": "specific actionable message", "severity": "info|warning|error"}]
}

Each suggestion must be:
- 20-80 words (not too short, not too long)
- Specific and actionable
- Non-obvious information
- Worth interrupting the conversation for

If nothing meets these criteria, return empty array: {"suggestions": []}`
                }, {
                    role: 'user',
                    content: `Recent conversation:\n${recentText}\n\nUser statements to analyze: ${userStatements || 'None yet'}`
                }],
                temperature: 0.3,
                max_tokens: 400,
                stream: false
            })
        });

        if (!response.ok) {
            throw new Error(`GPT error: ${response.status}`);
        }

        const result = await response.json();
        const content = result.choices[0].message.content;

        // Parse suggestions
        let suggestions = [];
        try {
            const parsed = JSON.parse(content.replace(/```json/g, '').replace(/```/g, '').trim());
            suggestions = parsed.suggestions || [];
        } catch (e) {
            console.error('Failed to parse suggestions:', e);
        }

        // Expanded web search triggers
        const hedgeWords = ['think', 'maybe', 'probably', 'might', 'seem', 'appear', 'suppose', 'possibly', 'believe', 'guess', 'wonder'];
        const factualPatterns = /\b(revenue|growth|team|product|plan|launch|users|customers|population|country|company|founded|CEO|raised|funding)\b/i;

        const hasHedge = hedgeWords.some(word => userStatements.toLowerCase().includes(word));
        const hasFactualClaim = factualPatterns.test(userStatements);

        // Enhanced web search for fact verification
        if (userStatements && (hasHedge || hasFactualClaim)) {
            // Extract potential facts to verify
            const factQueries = await craftSearchQueries(
                `Extract 2-3 specific factual claims from: "${userStatements}". Create precise search queries to verify these facts.`
            );

            if (factQueries.length > 0) {
                const searchResult = await parallelClient.beta.search({
                    objective: `Verify factual claims from meeting discussion`,
                    search_queries: factQueries.slice(0, 3),
                    mode: 'one-shot',
                    max_results: 6,
                    max_chars_per_result: 2500
                });

                if (searchResult.results && searchResult.results.length > 0) {
                    const verification = await synthesizeResults(
                        `Based on these search results, verify or correct the statement: "${userStatements}".

Rules:
- Only return verification if you have HIGH CONFIDENCE
- Return 1-2 sentences with specific facts/numbers
- If results are unclear or contradictory, return "Cannot verify"
- If statement is obviously correct, skip it`,
                        searchResult.results,
                        200
                    );

                    // Strict filtering for web search results
                    const lowConfidenceIndicators = ['cannot verify', 'unclear', 'no results', 'not found', 'insufficient', 'contradictory'];
                    const hasLowConfidence = lowConfidenceIndicators.some(ind =>
                        verification?.toLowerCase().includes(ind)
                    );

                    if (verification && !hasLowConfidence && verification.length > 20) {
                        suggestions.push({
                            type: 'fact',
                            message: verification,
                            severity: 'info'
                        });
                    }
                }
            }
        }

        // Filter and deduplicate suggestions
        const filteredSuggestions = suggestions.filter(sugg => {
            // Quality checks
            if (!sugg.message || sugg.message.length < 20 || sugg.message.length > 300) {
                return false;
            }

            // Filter generic suggestions
            if (isGenericSuggestion(sugg.message)) {
                return false;
            }

            // Deduplication check
            const hash = hashSuggestion(sugg);
            if (recentSuggestionHashes.has(hash)) {
                return false; // Duplicate
            }

            // Add to dedup set with timestamp
            recentSuggestionHashes.add(hash);
            // Auto-cleanup old hashes after 60 seconds
            setTimeout(() => recentSuggestionHashes.delete(hash), 60000);

            return true;
        });

        // Limit to top 3 suggestions per analysis
        const topSuggestions = filteredSuggestions.slice(0, 3);

        // Send suggestions to frontend
        if (topSuggestions.length > 0) {
            ws.send(JSON.stringify({
                type: 'suggestions',
                suggestions: topSuggestions,
                timestamp: Date.now()
            }));
        }

    } catch (error) {
        console.error('Analysis error:', error);
    }
}

// Handle interactive prep message with GPT-4o and function calling
async function handleInteractiveMessage(userMessage, meetingContext, conversationHistory) {
    console.log('🤖 Processing interactive message with GPT-4o');

    // Build conversation messages
    const messages = [
        {
            role: 'system',
            content: `You are an AI meeting preparation assistant. You have access to comprehensive meeting context and can search the web for additional information when needed.

Meeting Context:
${JSON.stringify(meetingContext, null, 2)}

Your capabilities:
1. Answer questions about the meeting (attendees, agenda, documents, etc.)
2. Provide insights and recommendations for meeting preparation
3. Search the web for current information when needed using the web_search tool

Guidelines:
- Be conversational and helpful
- Provide specific, actionable advice
- Reference the meeting context when relevant
- Use web search for facts you're uncertain about or for current information
- Keep responses concise but informative (2-4 sentences unless more detail is requested)`
        },
        ...conversationHistory.map(msg => ({
            role: msg.role,
            content: msg.content
        }))
    ];

    // Define web search tool
    const tools = [
        {
            type: 'function',
            function: {
                name: 'web_search',
                description: 'Search the web for current information. Use this when you need up-to-date facts, company information, or details not in the meeting context.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'The search query (be specific and focused)'
                        },
                        num_results: {
                            type: 'number',
                            description: 'Number of results to return (1-5)',
                            default: 3
                        }
                    },
                    required: ['query']
                }
            }
        }
    ];

    try {
        // First GPT-4o call with function calling
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                messages: messages,
                tools: tools,
                tool_choice: 'auto',
                temperature: 0.7,
                max_tokens: 500
            })
        });

        const data = await response.json();
        const assistantMessage = data.choices[0].message;

        // Check if tool call was made
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
            const toolCall = assistantMessage.tool_calls[0];

            if (toolCall.function.name === 'web_search') {
                const args = JSON.parse(toolCall.function.arguments);
                console.log('🔍 Web search requested:', args.query);

                // Execute web search using Parallel AI
                const searchResult = await parallelClient.beta.search({
                    objective: args.query,
                    search_queries: [args.query],
                    mode: 'one-shot',
                    max_results: args.num_results || 3,
                    max_chars_per_result: 2000
                });

                // Synthesize search results
                let searchSummary = 'No relevant results found.';
                if (searchResult.results && searchResult.results.length > 0) {
                    const resultsText = searchResult.results.map((r, i) =>
                        `Result ${i + 1}: ${r.title}\n${r.snippet || r.content?.substring(0, 300)}...`
                    ).join('\n\n');

                    searchSummary = await synthesizeResults(
                        `Summarize these search results for the query "${args.query}" in 2-3 clear sentences:`,
                        searchResult.results,
                        400
                    );
                }

                // Second GPT-4o call with search results
                const finalResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${OPENAI_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: 'gpt-4o',
                        messages: [
                            ...messages,
                            assistantMessage,
                            {
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                content: searchSummary
                            }
                        ],
                        temperature: 0.7,
                        max_tokens: 500
                    })
                });

                const finalData = await finalResponse.json();
                const finalMessage = finalData.choices[0].message.content;

                return {
                    message: finalMessage,
                    toolCall: { query: args.query }
                };
            }
        }

        // No tool call, return direct response
        return {
            message: assistantMessage.content,
            toolCall: null
        };

    } catch (error) {
        console.error('Error in handleInteractiveMessage:', error);
        throw error;
    }
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Proxy server is running',
        parallelApiConfigured: !!process.env.PARALLEL_API_KEY,
        deepgramConfigured: !!process.env.DEEPGRAM_API_KEY
    });
});

server.listen(PORT, () => {
    console.log(`\n🚀 Proxy server running on http://localhost:${PORT}`);
    console.log(`📡 Parallel AI API key: ${process.env.PARALLEL_API_KEY ? '✓ Configured' : '✗ Missing'}`);
    console.log(`🎤 Deepgram API key: ${process.env.DEEPGRAM_API_KEY ? '✓ Configured' : '✗ Missing'}`);
    console.log(`\nAvailable endpoints:`);
    console.log(`  POST /api/parallel-search   - Web search`);
    console.log(`  POST /api/parallel-extract  - Extract from URLs`);
    console.log(`  POST /api/parallel-research - Deep research tasks`);
    console.log(`  POST /api/prep-meeting      - Generate meeting brief`);
    console.log(`  WS   /ws/meeting-stream     - Real-time meeting assistant`);
    console.log(`  GET  /health                - Health check\n`);
});
