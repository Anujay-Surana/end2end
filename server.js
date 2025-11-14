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

// ===== CONTEXT FETCHING HELPERS =====

/**
 * Extract keywords from meeting title and description
 */
function extractKeywords(title, description = '') {
    const text = `${title} ${description}`.toLowerCase();
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
                       'meeting', 'discussion', 'call', 'review', 'session', 'sync', 'chat', 'talk'];

    const words = text
        .split(/[\s\-_,\.;:()[\]{}]+/)
        .filter(w => w.length > 3 && !stopWords.includes(w))
        .filter(w => !/^\d+$/.test(w)); // Remove pure numbers

    // Return unique words, max 5
    return [...new Set(words)].slice(0, 5);
}

/**
 * Fetch Gmail messages using user's access token
 */
async function fetchGmailMessages(accessToken, query, maxResults = 100) {
    try {
        console.log(`  📧 Gmail query: ${query.substring(0, 150)}...`);

        // Step 1: Get message IDs
        const listResponse = await fetch(
            `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
            {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            }
        );

        if (!listResponse.ok) {
            throw new Error(`Gmail API error: ${listResponse.status}`);
        }

        const listData = await listResponse.json();
        const messageIds = listData.messages || [];

        console.log(`  ✓ Found ${messageIds.length} message IDs`);

        if (messageIds.length === 0) {
            return [];
        }

        // Step 2: Fetch full message details (top 30 for performance)
        const fetchLimit = Math.min(messageIds.length, 30);
        const messagePromises = messageIds.slice(0, fetchLimit).map(async (msg) => {
            const msgResponse = await fetch(
                `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
                {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                }
            );

            if (!msgResponse.ok) {
                return null;
            }

            return msgResponse.json();
        });

        const messages = (await Promise.all(messagePromises)).filter(Boolean);

        console.log(`  ✓ Fetched ${messages.length} full messages`);

        // Step 3: Parse and format messages
        return messages.map(msg => {
            const headers = msg.payload?.headers || [];
            const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

            let body = '';
            if (msg.payload?.parts) {
                const textPart = msg.payload.parts.find(p => p.mimeType === 'text/plain');
                if (textPart?.body?.data) {
                    body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
                }
            } else if (msg.payload?.body?.data) {
                body = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
            }

            return {
                id: msg.id,
                subject: getHeader('Subject'),
                from: getHeader('From'),
                to: getHeader('To'),
                date: getHeader('Date'),
                snippet: msg.snippet || '',
                body: body.substring(0, 5000) // Limit body size
            };
        });

    } catch (error) {
        console.error('  ❌ Error fetching Gmail messages:', error.message);
        return [];
    }
}

/**
 * Fetch Google Drive files using user's access token
 */
async function fetchDriveFiles(accessToken, query, maxResults = 50) {
    try {
        console.log(`  📁 Drive query: ${query.substring(0, 150)}...`);

        const response = await fetch(
            `https://www.googleapis.com/drive/v3/files?` +
            `q=${encodeURIComponent(query)}&` +
            `fields=files(id,name,mimeType,modifiedTime,owners,size,webViewLink,iconLink)&` +
            `orderBy=modifiedTime desc&` +
            `pageSize=${maxResults}`,
            {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            }
        );

        if (!response.ok) {
            throw new Error(`Drive API error: ${response.status}`);
        }

        const data = await response.json();
        const files = data.files || [];

        console.log(`  ✓ Found ${files.length} Drive files`);

        return files.map(file => ({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size || 0,
            modifiedTime: file.modifiedTime,
            owner: file.owners && file.owners.length > 0 ? file.owners[0].displayName || file.owners[0].emailAddress : 'Unknown',
            ownerEmail: file.owners && file.owners.length > 0 ? file.owners[0].emailAddress : '',
            url: file.webViewLink,
            iconLink: file.iconLink
        }));

    } catch (error) {
        console.error('  ❌ Error fetching Drive files:', error.message);
        return [];
    }
}

/**
 * Fetch Drive file contents
 */
async function fetchDriveFileContents(accessToken, files) {
    const filesWithContent = [];

    for (const file of files.slice(0, 5)) { // Limit to 5 files for performance
        try {
            let content = '';

            // Handle different file types
            if (file.mimeType === 'application/vnd.google-apps.document') {
                // Google Doc - export as plain text
                const response = await fetch(
                    `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`,
                    {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    }
                );
                if (response.ok) {
                    content = await response.text();
                }
            } else if (file.mimeType === 'application/pdf' || file.mimeType === 'text/plain') {
                // PDF or text file - get binary content
                const response = await fetch(
                    `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
                    {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    }
                );
                if (response.ok) {
                    content = await response.text();
                }
            }

            if (content) {
                filesWithContent.push({
                    ...file,
                    content: content.substring(0, 20000) // Limit content size
                });
            }
        } catch (error) {
            console.error(`  ⚠️  Error fetching content for ${file.name}:`, error.message);
        }
    }

    return filesWithContent;
}

// ===== MEETING PREP ENDPOINT =====

app.post('/api/prep-meeting', async (req, res) => {
    try {
        const { meeting, attendees, accessToken } = req.body;

        console.log(`\n📋 Preparing brief for: ${meeting.summary}`);

        const brief = {
            summary: '',
            attendees: [],
            companies: [],
            actionItems: [],
            context: ''
        };

        // Extract keywords from meeting title/description for enhanced context fetching
        const keywords = extractKeywords(meeting.summary, meeting.description || '');
        console.log(`  🔑 Extracted keywords: ${keywords.join(', ')}`);

        // Fetch emails and files server-side with enhanced queries
        let emails = [];
        let files = [];

        if (accessToken && attendees && attendees.length > 0) {
            const attendeeEmails = attendees.map(a => a.email).filter(Boolean);
            const domains = [...new Set(attendeeEmails.map(e => e.split('@')[1]))];

            // CHANGE: Go back 2 YEARS (not 6 months) to get full relationship history
            // Working relationships can span years, and we need that context
            const twoYearsAgo = new Date();
            twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
            const afterDate = twoYearsAgo.toISOString().split('T')[0].replace(/-/g, '/');

            console.log(`  📅 Fetching context from the past 2 years (since ${afterDate})`);

            // Build enhanced Gmail query
            const attendeeQueries = attendeeEmails.map(email => `from:${email} OR to:${email}`).join(' OR ');
            const domainQueries = domains.map(d => `from:*@${d}`).join(' OR ');

            let keywordQuery = '';
            if (keywords.length > 0) {
                const keywordParts = keywords.slice(0, 3).map(k => `subject:"${k}" OR "${k}"`).join(' OR ');
                keywordQuery = ` OR (${keywordParts})`;
            }

            const gmailQuery = `(${attendeeQueries} OR ${domainQueries}${keywordQuery}) after:${afterDate}`;

            console.log(`  📧 Fetching emails with enhanced query...`);
            emails = await fetchGmailMessages(accessToken, gmailQuery, 100);
            console.log(`  ✓ Fetched ${emails.length} emails`);

            // Build enhanced Drive query (also 2 years back)
            const permQueries = attendeeEmails.map(email => `'${email}' in readers or '${email}' in writers`).join(' or ');
            const permQuery = `(${permQueries}) and modifiedTime > '${twoYearsAgo.toISOString()}'`;

            let nameQuery = '';
            if (keywords.length > 0) {
                const nameKeywords = keywords.slice(0, 3).map(k => `name contains '${k}'`).join(' or ');
                nameQuery = `(${nameKeywords}) and modifiedTime > '${twoYearsAgo.toISOString()}'`;
            }

            console.log(`  📁 Fetching Drive files with enhanced queries...`);

            // Fetch both permission-based and name-based files in parallel
            const [permFiles, nameFiles] = await Promise.all([
                fetchDriveFiles(accessToken, permQuery, 50),
                nameQuery ? fetchDriveFiles(accessToken, nameQuery, 30) : Promise.resolve([])
            ]);

            // Merge and deduplicate files by ID
            const fileMap = new Map();
            [...permFiles, ...nameFiles].forEach(file => {
                if (!fileMap.has(file.id)) {
                    fileMap.set(file.id, file);
                }
            });
            files = Array.from(fileMap.values());

            console.log(`  ✓ Fetched ${files.length} unique Drive files (${permFiles.length} from permissions, ${nameFiles.length} from keywords)`);

            // Fetch file contents
            if (files.length > 0) {
                console.log(`  📄 Fetching content for top ${Math.min(files.length, 5)} files...`);
                files = await fetchDriveFileContents(accessToken, files);
                console.log(`  ✓ Fetched content for ${files.length} files`);
            }
        }

        // Research attendees - prioritize local context, then web
        const attendeePromises = attendees.slice(0, 6).map(async (att) => {
            const domain = att.email.split('@')[1];
            const company = domain.split('.')[0];

            // Skip resource calendars (conference rooms)
            if (att.email.includes('@resource.calendar.google.com')) {
                console.log(`  ⏭️  Skipping resource calendar: ${att.displayName || att.email}`);
                return null;
            }

            // STEP 1: Determine best name to use (prioritize: Calendar displayName → Email From header → Email username)
            let name = att.displayName || att.email.split('@')[0];

            console.log(`  🔍 Researching: ${name} (${att.email})`);
            console.log(`    📋 Calendar display name: ${att.displayName || 'Not provided'}`);

            let keyFacts = [];
            let title = company;
            let source = 'local'; // Track data source

            // STEP 2: Extract full name from email headers if Calendar displayName wasn't provided or is incomplete
            // CRITICAL: Only match emails FROM this specific attendee (not just mentioning them)
            const attendeeEmails = emails ? emails.filter(e =>
                e.from?.toLowerCase().includes(att.email.toLowerCase())
            ) : [];

            // Try to extract full name from "From" header (format: "Full Name <email@domain.com>")
            if (attendeeEmails.length > 0 && (!att.displayName || !att.displayName.includes(' '))) {
                const fromHeader = attendeeEmails[0].from;
                const nameMatch = fromHeader?.match(/^([^<]+)(?=\s*<)/);
                if (nameMatch && nameMatch[1].trim()) {
                    const extractedName = nameMatch[1].trim().replace(/"/g, '');
                    // Only use if it's a proper full name (has space or is longer than original)
                    if (extractedName.includes(' ') || extractedName.length > name.length) {
                        console.log(`    📛 Extracted full name from email: "${extractedName}" (was: "${name}") [from: ${att.email}]`);
                        name = extractedName;
                    }
                }
            } else if (att.displayName && att.displayName.includes(' ')) {
                console.log(`    ✓ Using Calendar display name: "${att.displayName}"`);
            }

            if (attendeeEmails.length > 0) {
                console.log(`    📧 Found ${attendeeEmails.length} emails from ${name}`);
                const localSynthesis = await synthesizeResults(
                    `Analyze emails from ${name} (${att.email}) to extract key professional context for meeting "${meeting.summary}".

Extract and prioritize:
1. **Working relationship**: How do they work with the meeting organizer? Collaborative history? Decision authority?
2. **Current projects/progress**: What are they working on? What's the status? Any blockers or recent wins?
3. **Role and expertise**: Their position, responsibilities, areas of expertise
4. **Meeting-specific context**: References to agenda items, questions asked, documents shared
5. **Communication style**: Do they prefer details or summaries? Direct or diplomatic?

Return ONLY a JSON array of 3-6 specific, actionable facts. Include dates/specifics when available.

Examples:
- "Working together on Kordn8 MVP for 3+ months based on Nov-Jan email threads"
- "Blocked on UX design approval - mentioned in Dec 15 email, still unresolved as of Jan 10"
- "Prefers detailed technical discussions - often asks follow-up questions in email threads"
- "Requested agenda document for this meeting on Jan 8"

If emails lack substantive professional context, return: []`,
                    attendeeEmails.slice(0, 15),
                    600
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

            // STEP 2: ALWAYS do web search to supplement
            console.log(`    🌐 Performing web search...`);

            // Build highly specific search queries with strong company/domain signals
            // CRITICAL: Always include domain/company to avoid finding wrong person
            const queries = [];

            // Query 1: Name + domain (most reliable - directly tied to email)
            queries.push(`"${name}" site:linkedin.com ${domain}`);

            // Query 2: Name + company LinkedIn
            queries.push(`"${name}" ${company} site:linkedin.com`);

            // Query 3: Name + email (ultra specific)
            queries.push(`"${name}" "${att.email}"`);

            console.log(`    🔎 Search queries: ${queries.join(' | ')}`);

            const searchResult = await parallelClient.beta.search({
                objective: `Find LinkedIn profile and professional info for ${name} who works at ${company} (${att.email}). ONLY return results that mention ${domain} or ${company}.`,
                search_queries: queries,
                mode: 'one-shot',
                max_results: 8,
                max_chars_per_result: 2500
            });

            console.log(`    ✓ Found ${searchResult.results?.length || 0} web results`);

            let relevantResults = [];
            if (searchResult.results && searchResult.results.length > 0) {
                // Filter results to include those mentioning company name (more lenient than exact domain)
                // This allows LinkedIn profiles mentioning "Tonik" to match, not just "tonik.com"
                const companyNameOnly = company.toLowerCase();

                relevantResults = searchResult.results.filter(r => {
                    const textToSearch = `${r.title || ''} ${r.excerpt || ''} ${r.url || ''} ${(r.excerpts || []).join(' ')}`.toLowerCase();

                    // Check company name (lenient - partial match OK)
                    const mentionsCompany = textToSearch.includes(companyNameOnly);

                    // Also check if URL contains company name or LinkedIn profile pattern
                    const urlHasCompany = r.url?.toLowerCase().includes(companyNameOnly);
                    const isLinkedInProfile = r.url?.includes('linkedin.com/in/') || r.url?.includes('linkedin.com/company/');

                    return mentionsCompany || (urlHasCompany && isLinkedInProfile);
                });

                console.log(`    🔍 Filtered to ${relevantResults.length}/${searchResult.results.length} results mentioning ${company}`);

                if (relevantResults.length > 0) {
                    // Extract info from filtered results
                    const webSynthesis = await callGPT([{
                        role: 'system',
                        content: `Extract 2-4 professional facts about ${name} from ${company} (${att.email}).

These results have been pre-filtered to mention ${company}, so they should be about the correct person.

Return JSON array: ["fact 1", "fact 2", ...]

If results are ambiguous or clearly about someone else, return: []`
                    }, {
                        role: 'user',
                        content: `Web search results:\n${JSON.stringify(relevantResults.slice(0, 5), null, 2)}`
                    }], 600);

                    try {
                        let clean = webSynthesis?.replace(/```json/g, '').replace(/```/g, '').trim();
                        const parsed = JSON.parse(clean);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            // Add web facts
                            const webFacts = parsed.filter(f => f && f.length > 10);
                            keyFacts.push(...webFacts);
                            source = keyFacts.length > webFacts.length ? 'local+web' : 'web';
                            console.log(`    ✓ Added ${webFacts.length} facts from filtered web results`);
                        } else {
                            console.log(`    ⚠️  No usable facts from web results`);
                        }
                    } catch (e) {
                        console.log(`    ⚠️  Failed to parse web results: ${e.message}`);
                    }
                } else {
                    console.log(`    ⚠️  No results mentioned ${domain} or ${company} - skipping to avoid wrong person`);
                }
            } else {
                console.log(`    ⚠️  No web results found`);
            }

            // Try to extract title from filtered web results (if any)
            if (relevantResults && relevantResults.length > 0 && relevantResults[0]?.excerpts) {
                const excerpt = relevantResults[0].excerpts.join(' ');
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

        // Generate email analysis - meeting-specific with DEEP analysis
        console.log(`  📧 Analyzing email threads for meeting context...`);
        let emailAnalysis = '';
        if (emails && emails.length > 0) {
            console.log(`  📊 Performing deep email analysis on ${emails.length} emails...`);

            // Filter emails to those relevant to THIS meeting with BALANCED approach
            // Goal: Include useful business context while excluding obvious spam/newsletters
            const relevanceCheck = await callGPT([{
                role: 'system',
                content: `You are filtering emails for meeting prep. Meeting: "${meeting.summary}"

BALANCED FILTERING GUIDELINES:
✅ INCLUDE most emails EXCEPT obvious spam:
- Direct correspondence with attendees (discussions, questions, updates)
- Shared documents, links, or attachments related to work
- Meeting planning, scheduling, or follow-ups
- Project updates, progress reports, or status emails
- General business correspondence that provides relationship context
- Emails discussing companies, products, or topics relevant to attendees

❌ EXCLUDE only obvious spam/irrelevant:
- Marketing newsletters and promotional emails
- Event announcements for webinars/conferences
- Automated notifications (calendar, system alerts)
- Social event invitations unrelated to work

IMPORTANT: When in doubt, INCLUDE the email. Business context is valuable even if not directly about this specific meeting.

Return JSON array of email indices (0-based) that should be INCLUDED:
{"relevant_indices": [0, 3, 7, ...]}

Be generous - aim to include 50-70% of emails unless they're clearly spam.`
            }, {
                role: 'user',
                content: `Emails to filter:\n${emails.slice(0, 20).map((e, i) => `[${i}] Subject: ${e.subject}\nFrom: ${e.from}\nSnippet: ${e.snippet.substring(0, 200)}`).join('\n\n')}`
            }], 800);

            let relevantIndices = [];
            try {
                const parsed = JSON.parse(relevanceCheck.replace(/```json/g, '').replace(/```/g, '').trim());
                relevantIndices = parsed.relevant_indices || [];
            } catch (e) {
                console.log(`  ⚠️  Failed to parse relevance check, using all emails`);
                relevantIndices = emails.slice(0, 20).map((_, i) => i);
            }

            console.log(`  🔍 Filtered to ${relevantIndices.length}/${Math.min(emails.length, 20)} relevant emails`);

            // FALLBACK: If filter rejected everything, use most recent emails as context
            if (relevantIndices.length === 0) {
                console.log(`  ⚠️  All emails filtered out - using fallback (10 most recent emails for context)`);
                relevantIndices = emails.slice(0, 10).map((_, i) => i);
            }

            if (relevantIndices.length === 0) {
                emailAnalysis = `No email threads found directly related to "${meeting.summary}". Email activity exists but appears to be general correspondence rather than meeting-specific discussion.`;
            } else {
                const relevantEmails = relevantIndices.map(i => emails[i]).filter(Boolean);

                // PASS 1: Extract key topics, decisions, and action items from RELEVANT emails only
                const topicsExtraction = await callGPT([{
                    role: 'system',
                    content: `Deeply analyze these emails to extract ALL relevant context for meeting "${meeting.summary}".

CRITICAL: Focus on RELATIONSHIPS, PROGRESS, and BLOCKERS - not just topics.

Return a detailed JSON object:
{
  "workingRelationships": ["Who works with whom? What's the collaborative history? Authority/decision-making dynamics?"],
  "projectProgress": ["What's been accomplished? Current status? Timeline mentions? Milestones?"],
  "blockers": ["What's blocking progress? Unresolved questions? Pending decisions? Dependencies?"],
  "decisions": ["What decisions have been made? By whom? When? What's their impact?"],
  "actionItems": ["Who needs to do what? By when? What's the current status?"],
  "topics": ["Main discussion topics, agenda items, key themes"],
  "keyContext": ["Other important context: document references, past meetings, external dependencies"]
}

Be THOROUGH and SPECIFIC:
- Include names, dates, and document references
- Note who said what and when
- Identify patterns across multiple emails
- Extract both explicit statements and implicit context
- Each point should be 15-80 words with concrete details

Even "routine" business emails reveal working relationships and progress - extract that value!`
                }, {
                    role: 'user',
                    content: `Emails:\n${relevantEmails.map(e => `Subject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}\nBody: ${(e.body || e.snippet).substring(0, 1000)}`).join('\n\n---\n\n')}`
                }], 1200);

            let extractedData = { workingRelationships: [], projectProgress: [], blockers: [], decisions: [], actionItems: [], topics: [], keyContext: [] };
            try {
                extractedData = JSON.parse(topicsExtraction.replace(/```json/g, '').replace(/```/g, '').trim());
            } catch (e) {
                console.log(`  ⚠️  Failed to parse topics extraction, continuing...`);
            }

            // PASS 2: Synthesize into narrative focused on working relationships and progress
            const emailSummary = await callGPT([{
                role: 'system',
                content: `You are creating a comprehensive email analysis for meeting prep. Synthesize the extracted data into a detailed, insightful paragraph (8-12 sentences).

Extracted Data:
${JSON.stringify(extractedData, null, 2)}

CRITICAL PRIORITIES (in order):
1. **Working Relationships**: Start with HOW people work together - collaborative history, communication patterns, decision dynamics
2. **Progress & Status**: What's been accomplished? What's the current state? Include timeline context
3. **Blockers & Issues**: What's preventing progress? Unresolved questions? Pending decisions?
4. **Decisions & Actions**: What's been decided? Who needs to do what?
5. **Context**: Documents, past meetings, external factors

Guidelines:
- Write as if briefing an executive before a critical meeting
- Be SPECIFIC: include names, dates, document names, numbers
- Connect dots: show cause-effect, before-after, who-said-what
- Avoid generic statements like "team is working on X" - say HOW and WHY
- If data is sparse, acknowledge it but extract maximum value from what exists
- Every sentence must add actionable insight

Example tone: "Dobrochna and Akshay have been collaborating on the Kordn8 MVP since November, with Dobrochna leading product strategy and Akshay handling technical implementation (based on 12 email threads Nov-Jan). Progress has accelerated in January with completion of the authentication module, but UX design remains blocked pending Dobrochna's approval on wireframes sent Dec 15. The team requested a detailed agenda for this meeting on Jan 8, suggesting they're seeking clarity on next priorities..."

DO NOT write generic summaries. Extract and synthesize REAL working context.`
            }, {
                role: 'user',
                content: `Meeting: ${meeting.summary}\n\nCreate comprehensive email analysis paragraph.`
            }], 800);

                emailAnalysis = emailSummary?.trim() || 'Limited email context available for this meeting.';
                console.log(`  ✓ Email analysis: ${emailAnalysis.length} chars from ${relevantEmails.length} relevant emails`);
            }
        } else {
            emailAnalysis = 'No email activity found in the past 6 months.';
        }

        // Generate document/file analysis - meeting-specific with DEEP content analysis
        console.log(`  📄 Analyzing document content for meeting relevance...`);
        let documentAnalysis = '';
        if (files && files.length > 0) {
            // Filter files with content
            const filesWithContent = files.filter(f => f.content && f.content.length > 100);

            if (filesWithContent.length > 0) {
                console.log(`  📊 Deep analysis of ${filesWithContent.length} documents with content...`);

                // PASS 1: Extract key information from EACH document
                const docInsights = await Promise.all(
                    filesWithContent.slice(0, 5).map(async (file) => {
                        const insight = await callGPT([{
                            role: 'system',
                            content: `Analyze this document for meeting "${meeting.summary}". Extract 3-7 KEY INSIGHTS.

Return JSON array of insights:
["insight 1", "insight 2", ...]

Each insight should:
- Be specific (include numbers, dates, names, decisions)
- Be 20-80 words
- Quote or reference specific content
- Explain relevance to the meeting

Focus on: decisions, data, action items, proposals, problems, solutions, timelines.`
                        }, {
                            role: 'user',
                            content: `Document: "${file.name}"\n\nContent:\n${file.content.substring(0, 12000)}`
                        }], 900);

                        try {
                            const parsed = JSON.parse(insight.replace(/```json/g, '').replace(/```/g, '').trim());
                            return { fileName: file.name, insights: Array.isArray(parsed) ? parsed : [] };
                        } catch (e) {
                            return { fileName: file.name, insights: [] };
                        }
                    })
                );

                // PASS 2: Synthesize all document insights into coherent narrative
                const allInsights = docInsights.filter(d => d.insights.length > 0);

                if (allInsights.length > 0) {
                    const docNarrative = await callGPT([{
                        role: 'system',
                        content: `You are creating a comprehensive document analysis for meeting prep. Synthesize these document insights into a detailed paragraph (6-12 sentences).

Document Insights:
${JSON.stringify(allInsights, null, 2)}

Guidelines:
- Organize by importance and relevance to meeting "${meeting.summary}"
- Reference specific documents by name
- Include concrete details: numbers, dates, decisions, proposals
- Connect insights across documents if relevant
- Highlight any conflicts or discrepancies
- Focus on actionable information for the meeting

Write as if briefing an executive. Every sentence should provide specific, valuable information.`
                    }, {
                        role: 'user',
                        content: `Create comprehensive document analysis for meeting: ${meeting.summary}`
                    }], 1000);

                    documentAnalysis = docNarrative?.trim() || 'Document analysis in progress.';
                    console.log(`  ✓ Document analysis: ${documentAnalysis.length} chars from ${allInsights.length} docs`);
                } else {
                    documentAnalysis = `Analyzed ${filesWithContent.length} documents but found limited content directly relevant to "${meeting.summary}". Documents available: ${filesWithContent.map(f => f.name).join(', ')}.`;
                }
            } else if (files.length > 0) {
                // Fallback to title-based analysis if no content
                documentAnalysis = `Found ${files.length} potentially relevant documents: ${files.map(f => f.name).slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}. Unable to access full content for detailed analysis.`;
            }
        } else {
            documentAnalysis = 'No relevant documents found in Drive.';
        }

        // Generate company/context research - DEEP extraction from LOCAL context
        console.log(`  🏢 Analyzing company intelligence from local sources...`);
        let companyResearch = '';

        if ((emails && emails.length > 0) || (files && files.length > 0)) {
            console.log(`  📊 Extracting company intelligence from emails and documents...`);

            // PASS 1: Extract ALL company-related information
            const companyExtraction = await callGPT([{
                role: 'system',
                content: `Extract ALL company-related intelligence from these emails and documents for meeting "${meeting.summary}".

Return detailed JSON:
{
  "companyUpdates": ["update 1", "update 2", ...],
  "productDevelopments": ["development 1", "development 2", ...],
  "businessMetrics": ["metric 1", "metric 2", ...],
  "strategicContext": ["context 1", "context 2", ...],
  "teamChanges": ["change 1", "change 2", ...],
  "challenges": ["challenge 1", "challenge 2", ...]
}

Be thorough - extract EVERYTHING related to company/business context. Include specifics: numbers, dates, names, products.`
            }, {
                role: 'user',
                content: `Emails (top 15):\n${emails?.slice(0, 15).map(e => `Subject: ${e.subject}\nFrom: ${e.from}\nBody: ${(e.body || e.snippet).substring(0, 800)}`).join('\n\n---\n\n')}\n\nDocuments:\n${files?.filter(f => f.content).slice(0, 3).map(f => `Document: ${f.name}\nContent: ${f.content.substring(0, 3000)}`).join('\n\n---\n\n')}`
            }], 1200);

            let companyData = {
                companyUpdates: [],
                productDevelopments: [],
                businessMetrics: [],
                strategicContext: [],
                teamChanges: [],
                challenges: []
            };

            try {
                companyData = JSON.parse(companyExtraction.replace(/```json/g, '').replace(/```/g, '').trim());
            } catch (e) {
                console.log(`  ⚠️  Failed to parse company extraction, continuing...`);
            }

            // PASS 2: Synthesize into executive intelligence brief
            const hasData = Object.values(companyData).some(arr => arr && arr.length > 0);

            if (hasData) {
                const companyNarrative = await callGPT([{
                    role: 'system',
                    content: `Create a comprehensive company intelligence brief (5-8 sentences) from this extracted data.

Company Data:
${JSON.stringify(companyData, null, 2)}

Guidelines:
- Start with the most strategic/important information
- Include specific details: numbers, dates, product names, metrics
- Connect related points to show business narrative
- Highlight any challenges or opportunities
- Focus on information that provides advantage in meeting "${meeting.summary}"
- Be concrete and specific - avoid vague statements

Write as if briefing an executive on critical company intelligence before a high-stakes meeting.`
                }, {
                    role: 'user',
                    content: `Create company intelligence brief for meeting: ${meeting.summary}`
                }], 800);

                companyResearch = companyNarrative?.trim() || 'Company intelligence analysis in progress.';
                console.log(`  ✓ Company intel: ${companyResearch.length} chars`);
            } else {
                companyResearch = 'No substantive company or business context found in available emails and documents.';
            }
        } else {
            companyResearch = 'No company context available - no emails or documents to analyze.';
        }

        // ============================================================================
        // RELATIONSHIP ANALYSIS - Synthesize ALL context to understand working dynamics
        // ============================================================================
        console.log(`  🤝 Analyzing working relationships between attendees...`);
        let relationshipAnalysis = '';

        if (emails && emails.length > 0) {
            // Synthesize relationship dynamics using ALL gathered context
            const relationshipPrompt = `You are analyzing the working relationships between meeting attendees for: "${meeting.summary}"

You have access to ALL gathered context:

ATTENDEES:
${brief.attendees.map(a => `- ${a.name} (${a.email})${a.role ? ` - ${a.role}` : ''}
  Key facts: ${a.keyFacts.join('; ') || 'None gathered'}`).join('\n')}

EMAIL ANALYSIS (${emails.length} emails analyzed):
${emailAnalysis}

DOCUMENT ANALYSIS (${files ? files.length : 0} documents):
${documentAnalysis}

COMPANY CONTEXT:
${companyResearch}

Your task is to deeply analyze the WORKING RELATIONSHIPS between these people. Answer these critical questions:

1. **How do they know each other?**
   - What's their collaborative history? How long have they been working together?
   - What projects have they collaborated on?
   - Include specific dates, email references, document mentions

2. **What is their working dynamic?**
   - Who makes decisions? Who implements? Who advises?
   - Communication patterns: formal/informal, responsive/delayed, detailed/brief
   - Trust level and rapport based on email tone and content

3. **What are the power dynamics?**
   - Who has authority? Who reports to whom (if apparent)?
   - Who drives the agenda? Whose opinion carries weight?
   - Any signs of organizational hierarchy or peer relationships?

4. **Are there any unresolved issues or tensions?**
   - Pending decisions that affect their relationship?
   - Blockers or dependencies between them?
   - Disagreements or different perspectives mentioned?
   - Outstanding questions or concerns from either party?

Write a comprehensive 8-12 sentence analysis that synthesizes ALL the context above. Be SPECIFIC:
- Reference actual emails with dates/subjects when possible
- Mention specific documents they've collaborated on
- Quote or paraphrase key exchanges that reveal dynamics
- Connect dots across multiple data points
- If data is limited, acknowledge it but extract maximum insight

Example tone:
"Based on 15 email threads spanning November 2024 to January 2025, Dobrochna and Akshay have an active working relationship centered on the Kordn8 MVP project. Dobrochna appears to be in a leadership/decision-making role (requested detailed agenda Dec 15, approved wireframes Jan 3), while Akshay handles technical implementation (shared 'MVP Functions Detailed Report' Nov 9, sent build updates Dec 20). Their communication is collaborative and frequent (2-3 emails per week), with Akshay proactively sharing progress and Dobrochna providing strategic direction. However, there's a pending blocker: UX design approval has been delayed since Akshay's Dec 15 wireframe submission, with no response as of Jan 10 - this may be a discussion point for the meeting. The 'Short Term User Stickiness' document (Dec 8) shows shared concern about retention, suggesting aligned priorities. Email tone is professional but warm, indicating established rapport. No significant tensions evident, though Akshay's Jan 8 request for a detailed agenda suggests he prefers structure and clarity..."

Write as if briefing someone before a critical meeting where understanding the relationship dynamics could make the difference between success and failure.`;

            relationshipAnalysis = await synthesizeResults([{
                role: 'system',
                content: relationshipPrompt
            }, {
                role: 'user',
                content: `Analyze the relationships for meeting: ${meeting.summary}`
            }], null, 1200);

            relationshipAnalysis = relationshipAnalysis?.trim() || 'Insufficient context to analyze working relationships. More email history or documents needed.';
            console.log(`  ✓ Relationship analysis: ${relationshipAnalysis.length} chars`);
        } else {
            relationshipAnalysis = 'No relationship context available - no email history found to analyze working dynamics.';
        }

        // ============================================================================
        // TIMELINE BUILDING - Extract all interactions chronologically
        // ============================================================================
        console.log(`  📅 Building interaction timeline...`);
        const timeline = [];

        // Extract email events
        if (emails && emails.length > 0) {
            emails.forEach(email => {
                const emailDate = email.date ? new Date(email.date) : null;
                if (emailDate && !isNaN(emailDate.getTime())) {
                    // Extract participants from email
                    const participants = [];
                    if (email.from) {
                        const fromMatch = email.from.match(/^([^<]+)(?=\s*<)|^([^@]+@[^>]+)$/);
                        if (fromMatch) {
                            participants.push(fromMatch[1]?.trim().replace(/"/g, '') || fromMatch[2]?.trim() || email.from);
                        }
                    }

                    timeline.push({
                        type: 'email',
                        date: emailDate.toISOString(),
                        timestamp: emailDate.getTime(),
                        subject: email.subject || 'No subject',
                        participants: participants,
                        snippet: email.snippet?.substring(0, 150) || ''
                    });
                }
            });
            console.log(`    ✓ Added ${emails.length} email events to timeline`);
        }

        // Extract document events
        if (files && files.length > 0) {
            files.forEach(file => {
                // Use modified time (most recent interaction)
                const modifiedDate = file.modifiedTime ? new Date(file.modifiedTime) : null;
                if (modifiedDate && !isNaN(modifiedDate.getTime())) {
                    const owners = [];
                    if (file.owners && file.owners.length > 0) {
                        owners.push(...file.owners.map(o => o.displayName || o.emailAddress || 'Unknown'));
                    }

                    timeline.push({
                        type: 'document',
                        date: modifiedDate.toISOString(),
                        timestamp: modifiedDate.getTime(),
                        name: file.name || 'Unnamed document',
                        participants: owners,
                        action: 'modified',
                        mimeType: file.mimeType
                    });
                }

                // Also add creation time if different and available
                const createdDate = file.createdTime ? new Date(file.createdTime) : null;
                if (createdDate && !isNaN(createdDate.getTime()) &&
                    createdDate.getTime() !== modifiedDate?.getTime()) {
                    const owners = [];
                    if (file.owners && file.owners.length > 0) {
                        owners.push(...file.owners.map(o => o.displayName || o.emailAddress || 'Unknown'));
                    }

                    timeline.push({
                        type: 'document',
                        date: createdDate.toISOString(),
                        timestamp: createdDate.getTime(),
                        name: file.name || 'Unnamed document',
                        participants: owners,
                        action: 'created',
                        mimeType: file.mimeType
                    });
                }
            });
            console.log(`    ✓ Added ${files.length} document events to timeline`);
        }

        // Sort by timestamp (most recent first)
        timeline.sort((a, b) => b.timestamp - a.timestamp);

        // Limit to 100 most recent events
        const limitedTimeline = timeline.slice(0, 100);
        console.log(`  ✓ Timeline built: ${limitedTimeline.length} events (sorted by most recent)`);

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
        brief.relationshipAnalysis = relationshipAnalysis;
        brief.timeline = limitedTimeline;
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

                // Clear any existing interactive mode state (prevents cross-meeting contamination)
                if (ws.interactiveDeepgram) {
                    ws.interactiveDeepgram.finish();
                }

                // Set new context
                ws.interactivePrepContext = data.meetingBrief;
                ws.isInteractiveMode = true;
                ws.interactiveConversation = [];
                ws.interactiveDeepgram = null;
                ws.interactiveVoiceBuffer = '';

                console.log(`   📝 Meeting context: ${data.meetingBrief?.summary?.substring(0, 50) || 'Unknown'}`);
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

        // CRITICAL: Clear interactive prep context to prevent data leakage
        ws.interactivePrepContext = null;
        ws.isInteractiveMode = false;
        ws.interactiveConversation = [];
        ws.interactiveVoiceBuffer = '';

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
