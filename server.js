const express = require('express');
const cors = require('cors');
const Parallel = require('parallel-web');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = 3000;

// Initialize Parallel AI client
const parallelClient = new Parallel({
    apiKey: process.env.PARALLEL_API_KEY
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Enable CORS for our frontend
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for large context

// Serve static files (frontend)
app.use(express.static(__dirname));

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

            // STEP 2: Only do web search if we have minimal local context
            if (keyFacts.length < 2) {
                console.log(`    🌐 Supplementing with web search...`);

                // Craft queries with email domain for disambiguation
                const queries = await craftSearchQueries(
                    `${name} ${att.email} ${domain}. Find current role and professional background. Include email domain to find the RIGHT person.`
                );

                if (queries.length === 0) {
                    queries.push(
                        `"${name}" ${domain} LinkedIn profile`,
                        `"${name}" ${att.email} role`
                    );
                }

                const searchResult = await parallelClient.beta.search({
                    objective: `Find professional information about ${name} at ${domain}`,
                    search_queries: queries.slice(0, 3),
                    mode: 'one-shot',
                    max_results: 5,
                    max_chars_per_result: 2000
                });

                console.log(`    ✓ Found ${searchResult.results?.length || 0} web results`);

                // CONFIDENCE CHECK: Verify we found the right person
                const hasEmailMatch = searchResult.results?.some(r =>
                    r.url?.includes(domain) ||
                    r.excerpts?.some(ex => ex.includes(att.email) || ex.includes(domain))
                );

                if (hasEmailMatch || searchResult.results?.length > 0) {
                    const webSynthesis = await synthesizeResults(
                        `Extract professional info about ${name} from ${domain} (email: ${att.email}).

CRITICAL: Only include info if you're CONFIDENT it's about THIS specific person (check email domain matches).

If unsure or if results seem to be about a different person, return empty array: []

Return JSON array of 2-3 specific, verified facts ONLY if confident.`,
                        searchResult.results,
                        500
                    );

                    try {
                        let clean = webSynthesis?.replace(/```json/g, '').replace(/```/g, '').trim();
                        const parsed = JSON.parse(clean);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            // Add web facts, marking them as supplementary
                            keyFacts.push(...parsed.filter(f => f && f.length > 10));
                            source = keyFacts.length > parsed.length ? 'local+web' : 'web';
                            console.log(`    ✓ Added ${parsed.length} facts from web`);
                        }
                    } catch (e) {
                        console.log(`    ⚠️  Web results low confidence, skipping`);
                    }
                }

                // Try to extract title from web results
                if (searchResult.results?.[0]?.excerpts) {
                    const excerpt = searchResult.results[0].excerpts.join(' ');
                    const titleMatch = excerpt.match(new RegExp(`${name}[^,.]*(CEO|CTO|VP|Director|Head|Manager|Engineer|Designer|Lead|Founder|Partner|Analyst|Specialist|Coordinator)[^,.]{0,30}`, 'i'));
                    if (titleMatch && excerpt.includes(domain)) {
                        title = titleMatch[0].trim();
                    }
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

        console.log(`  📝 Generating action items...`);

        // Generate action items with full context
        const actionPrompt = `Based on this meeting information, suggest 3-5 specific action items to prepare effectively.

Meeting: ${meeting.summary}
Attendees: ${brief.attendees.map(a => `${a.name} (${a.title})`).join(', ')}
Recent emails: ${emails?.slice(0, 5).map(e => e.subject).join('; ')}

Return ONLY a JSON array of actionable preparation steps. Each item should be:
- Specific and concrete (what to review, prepare, or research)
- Actionable before the meeting
- Relevant to the attendees and context
- 10-40 words

Example format:
["Review Q3 sales metrics and prepare comparison with Q2 targets", "Research competitor pricing models mentioned in John's last email", "Prepare technical architecture diagram for the new API integration"]

Return ONLY the JSON array, no other text.`;

        const actionResult = await synthesizeResults(actionPrompt, summaryData, 400);

        try {
            let cleanAction = actionResult
                .replace(/```json/g, '')
                .replace(/```/g, '')
                .trim();
            const parsed = JSON.parse(cleanAction);
            brief.actionItems = Array.isArray(parsed) ? parsed
                .filter(item => item && typeof item === 'string' && item.length > 10)
                .slice(0, 5) : [];
        } catch (e) {
            console.error(`  ⚠️  Failed to parse action items:`, e.message);
            // Fallback parsing
            brief.actionItems = actionResult ?
                actionResult
                    .split(/[\n•\-]/)
                    .map(a => a.trim().replace(/^[\d\.\)]+\s*/, ''))
                    .filter(a => a && a.length > 10)
                    .slice(0, 5) : [];
        }

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

        // Generate document/file analysis - meeting-specific
        console.log(`  📄 Analyzing documents for meeting relevance...`);
        let documentAnalysis = '';
        if (files && files.length > 0) {
            const docSummary = await synthesizeResults(
                `You are preparing for a meeting titled "${meeting.summary}". Analyze these documents and identify which are directly relevant to THIS SPECIFIC MEETING.

For each relevant document:
- Explain what it likely contains based on the title
- How it specifically relates to the meeting discussion
- What key points or sections to review

If a document seems unrelated to the meeting topic, don't mention it.

Return a 3-5 sentence paragraph focused ONLY on meeting-relevant documents. Be specific about what to look for in each document.`,
                files.slice(0, 8).map(f => ({
                    name: f.name,
                    mimeType: f.mimeType,
                    modifiedTime: f.modifiedTime
                })),
                500
            );
            documentAnalysis = docSummary || 'No meeting-relevant documents identified.';
        }

        // Generate company/context research
        console.log(`  🏢 Researching companies...`);
        const companyNames = [...new Set(brief.attendees.map(a => a.title).filter(t => t))];
        let companyResearch = '';
        if (companyNames.length > 0) {
            const companyQueries = await craftSearchQueries(
                `Companies mentioned: ${companyNames.join(', ')}. Find recent news, funding, product launches, or notable developments.`
            );

            if (companyQueries.length > 0) {
                const companyResults = await parallelClient.beta.search({
                    objective: `Find recent company news and developments`,
                    search_queries: companyQueries.slice(0, 3),
                    mode: 'one-shot',
                    max_results: 6,
                    max_chars_per_result: 2000
                });

                const companySummary = await synthesizeResults(
                    `Summarize key company developments, news, or context that would be relevant for this meeting.

Return a 3-4 sentence paragraph covering:
- Recent company news or announcements
- Funding, growth, or business developments
- Industry trends or competitive positioning
- Anything relevant to meeting discussions

Be specific with dates and numbers where available.`,
                    companyResults.results,
                    600
                );
                companyResearch = companySummary || 'No recent company developments found.';
            }
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

        // Assemble comprehensive brief
        brief.emailAnalysis = emailAnalysis;
        brief.documentAnalysis = documentAnalysis;
        brief.companyResearch = companyResearch;
        brief.recommendations = parsedRecommendations;

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

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Proxy server is running',
        parallelApiConfigured: !!process.env.PARALLEL_API_KEY
    });
});

app.listen(PORT, () => {
    console.log(`\n🚀 Proxy server running on http://localhost:${PORT}`);
    console.log(`📡 Parallel AI API key: ${process.env.PARALLEL_API_KEY ? '✓ Configured' : '✗ Missing'}`);
    console.log(`\nAvailable endpoints:`);
    console.log(`  POST /api/parallel-search   - Web search`);
    console.log(`  POST /api/parallel-extract  - Extract from URLs`);
    console.log(`  POST /api/parallel-research - Deep research tasks`);
    console.log(`  POST /api/prep-meeting      - Generate meeting brief`);
    console.log(`  GET  /health                - Health check\n`);
});
