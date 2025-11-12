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

        // Research attendees in parallel
        const attendeePromises = attendees.slice(0, 6).map(async (att) => {
            const name = att.displayName || att.email.split('@')[0];
            const domain = att.email.split('@')[1];
            const company = domain.split('.')[0];

            console.log(`  🔍 Researching: ${name} at ${company}`);

            // Craft queries with GPT
            const queries = await craftSearchQueries(
                `Person: ${name} at ${company}. Find their current role, recent work/projects, professional background, and any notable achievements or activities.`
            );

            if (queries.length === 0) {
                queries.push(`${name} ${company} LinkedIn`, `${name} ${company} role`, `${name} ${company} bio`);
            }

            // Search with Parallel AI - more comprehensive
            const searchResult = await parallelClient.beta.search({
                objective: `Find detailed professional information about ${name} from ${company}`,
                search_queries: queries.slice(0, 3),
                mode: 'one-shot',
                max_results: 8,
                max_chars_per_result: 3000
            });

            console.log(`  ✓ Found ${searchResult.results?.length || 0} results for ${name}`);

            // Synthesize with GPT
            const synthesis = await synthesizeResults(
                `Analyze the search results about ${name} and extract 3-4 key facts that would be valuable to know before a meeting.

Focus on:
- Current role and responsibilities
- Recent achievements, projects, or announcements
- Professional background and expertise areas
- Company context (funding, growth, initiatives)

Return ONLY a JSON array of fact strings. Each fact should be:
- Specific and informative (not generic like "works at ${company}")
- 15-80 words
- Verified from the search results
- Useful for business meeting context

Example good output:
["Leads the AI Infrastructure team at ${company}, managing 15+ engineers", "Previously VP of Engineering at startup that was acquired by Google in 2021", "Recently published research on distributed systems at SOSP conference"]

Return ONLY the JSON array, no other text.`,
                searchResult.results,
                600
            );

            let keyFacts = [];
            let title = company;

            try {
                // Clean up JSON artifacts
                let cleanSynthesis = synthesis
                    .replace(/```json/g, '')
                    .replace(/```/g, '')
                    .trim();

                const parsed = JSON.parse(cleanSynthesis);
                if (Array.isArray(parsed)) {
                    keyFacts = parsed
                        .filter(fact =>
                            fact &&
                            typeof fact === 'string' &&
                            fact.length > 15 &&
                            fact.length < 200 &&
                            // Only filter truly useless statements
                            !fact.toLowerCase().match(/^(works? (at|in|for)|based in|active on|experienced|professional)/i)
                        )
                        .slice(0, 4);
                }
            } catch (e) {
                console.error(`  ⚠️  Failed to parse synthesis for ${name}:`, e.message);
                // Fallback: try to extract bullet points or lines
                if (synthesis) {
                    keyFacts = synthesis
                        .split(/[\n•\-]/)
                        .map(f => f.trim().replace(/^[\d\.\)]+\s*/, ''))
                        .filter(f => f && f.length > 15 && f.length < 200)
                        .slice(0, 4);
                }
            }

            // Try to extract a better title from search results
            if (searchResult.results?.[0]?.title) {
                title = searchResult.results[0].title;
            }
            if (searchResult.results?.[0]?.excerpts) {
                const excerpt = searchResult.results[0].excerpts.join(' ');
                // Look for title patterns
                const titleMatch = excerpt.match(new RegExp(`${name}[^,.]*(CEO|CTO|VP|Director|Head|Manager|Engineer|Designer|Lead|Founder|Partner)[^,.]*`, 'i'));
                if (titleMatch) {
                    title = titleMatch[0].trim();
                }
            }

            console.log(`  ✓ Extracted ${keyFacts.length} facts for ${name}`);

            return {
                name: name,
                email: att.email,
                title: title,
                keyFacts: keyFacts
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

        // Generate email analysis
        console.log(`  📧 Analyzing email threads...`);
        let emailAnalysis = '';
        if (emails && emails.length > 0) {
            const emailSummary = await synthesizeResults(
                `Analyze these email threads and extract key themes, decisions, and action items discussed.

Return a 3-5 sentence paragraph summarizing:
- Main topics discussed
- Important decisions or agreements
- Outstanding questions or action items
- Tone and urgency of communications

Be specific and reference actual email content.`,
                emails.slice(0, 10),
                500
            );
            emailAnalysis = emailSummary || 'No significant email activity found.';
        }

        // Generate document/file analysis
        console.log(`  📄 Analyzing documents...`);
        let documentAnalysis = '';
        if (files && files.length > 0) {
            const docSummary = await synthesizeResults(
                `Based on these document titles and metadata, infer what materials are relevant for this meeting.

Return a 2-3 sentence paragraph describing:
- What these documents likely contain
- How they relate to the meeting topic
- What to review or prepare from them

Be concise but specific.`,
                files.slice(0, 5),
                400
            );
            documentAnalysis = docSummary || 'No relevant documents identified.';
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

        // Generate strategic recommendations
        console.log(`  💡 Generating recommendations...`);
        const recommendations = await synthesizeResults(
            `Based on all the meeting context, provide 3-5 strategic recommendations or discussion points.

Consider:
- Attendee backgrounds and expertise
- Recent email discussions
- Company context
- Meeting objectives

Return ONLY a JSON array of recommendation strings. Each should be:
- Specific and actionable
- Tailored to this specific meeting
- 20-60 words
- Strategic rather than tactical

Example:
["Leverage Susannah's life sciences expertise to discuss healthcare AI applications, referencing her recent SPC blog post", "Propose pilot program with Kordn8's MVP, addressing the prototype limitations mentioned in recent reports"]

Return ONLY the JSON array.`,
            {
                meeting: { title: meeting.summary, description: meeting.description },
                attendees: brief.attendees,
                emails: emails?.slice(0, 5),
                files: files?.slice(0, 3),
                companyContext: companyResearch
            },
            800
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
