const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@deepgram/sdk');
const Parallel = require('parallel-web');
const fetch = require('node-fetch');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const VoiceConversationManager = require('./services/voiceConversation');
const VoicePrepManager = require('./services/voicePrepBriefing');
const ChatPanelService = require('./services/chatPanelService');
const { fetchGmailMessages, fetchDriveFiles, fetchDriveFileContents } = require('./services/googleApi');
const logger = require('./services/logger');
require('dotenv').config();

const app = express();

// Trust proxy for Railway (allows Express to detect HTTPS from X-Forwarded-Proto header)
app.set('trust proxy', 1);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;

// ===== ENVIRONMENT VARIABLE VALIDATION =====
logger.info('Validating environment variables...');

const requiredEnvVars = {
    'OPENAI_API_KEY': process.env.OPENAI_API_KEY,
    'PARALLEL_API_KEY': process.env.PARALLEL_API_KEY,
    'DEEPGRAM_API_KEY': process.env.DEEPGRAM_API_KEY,
    'SUPABASE_URL': process.env.SUPABASE_URL,
    'SUPABASE_SERVICE_ROLE_KEY': process.env.SUPABASE_SERVICE_ROLE_KEY,
    'SESSION_SECRET': process.env.SESSION_SECRET
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
    logger.error({ missingVars }, 'Missing required environment variables');
    console.error('Please add them to your .env file and restart the server.\n');
    process.exit(1);
}

if (invalidVars.length > 0) {
    logger.warn({ invalidVars }, 'Invalid/placeholder values detected');
    console.error('Please update these with your actual API keys in the .env file.\n');
    process.exit(1);
}

logger.info('All required environment variables are set');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Initialize Chat Panel Service
const chatPanelService = new ChatPanelService(OPENAI_API_KEY);

// Initialize Parallel AI client
const parallelClient = new Parallel({
    apiKey: process.env.PARALLEL_API_KEY
});

// Initialize Deepgram client (simple initialization - SDK handles endpoints)
let deepgram;
try {
    deepgram = createClient(DEEPGRAM_API_KEY);
    logger.info('Deepgram client initialized');
} catch (error) {
    logger.error({ error: error.message }, 'Failed to initialize Deepgram client');
    console.error('Please check your DEEPGRAM_API_KEY in the .env file.\n');
    process.exit(1);
}

// Enable CORS for our frontend
// Environment-aware CORS configuration
const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, Postman, etc.)
        if (!origin) {
            return callback(null, true);
        }
        
        // In production, check allowed origins
        if (process.env.NODE_ENV === 'production') {
            const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
            // Allow Capacitor app origins, Railway domain, and localhost
            if (origin.startsWith('capacitor://') || 
                origin.startsWith('ionic://') ||
                origin.includes('localhost') ||
                origin.includes('railway.app') ||
                origin.includes('end2end-production.up.railway.app') ||
                allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            return callback(new Error('Not allowed by CORS'));
        }
        
        // In development, allow all origins (including Capacitor)
        callback(null, true);
    },
    credentials: true, // Allow cookies
    optionsSuccessStatus: 200 // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' })); // Increase limit for large context
app.use(cookieParser()); // Parse cookies for session management

// Request logging middleware (must be after body parsing)
const requestLogger = require('./middleware/requestLogger');
app.use(requestLogger);

// Configure express-session middleware
// Note: We use database-backed sessions (sessions table) but express-session
// provides cookie management and session middleware integration
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    },
    // We don't use express-session's store since we have our own database sessions
    // The middleware is mainly for cookie management and req.session object
    name: 'session' // Cookie name
}));

// Make Parallel API client available to all routes
app.use((req, res, next) => {
    req.parallelClient = parallelClient;
    next();
});

// Serve static files (frontend)
app.use(express.static(__dirname));

// ===== MULTI-ACCOUNT ROUTES =====
// Mount authentication routes
const authRoutes = require('./routes/auth');
app.use('/auth', authRoutes);

// Mount account management routes
const accountRoutes = require('./routes/accounts');
app.use('/api/accounts', accountRoutes);

// Mount meeting preparation routes (supports both multi-account and legacy single-account)
const meetingRoutes = require('./routes/meetings');
app.use('/api', meetingRoutes);

// Mount day prep routes
const dayPrepRoutes = require('./routes/dayPrep');
app.use('/api', dayPrepRoutes);

// TTS endpoint - uses OpenAI TTS
const { validateTTS } = require('./middleware/validation');
const { ttsLimiter } = require('./middleware/rateLimiter');
app.post('/api/tts', ttsLimiter, validateTTS, async (req, res) => {
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
const { validateParallelSearch } = require('./middleware/validation');
const { parallelAILimiter } = require('./middleware/rateLimiter');
app.post('/api/parallel-search', parallelAILimiter, validateParallelSearch, async (req, res) => {
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
const { validateParallelExtract } = require('./middleware/validation');
app.post('/api/parallel-extract', parallelAILimiter, validateParallelExtract, async (req, res) => {
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
app.post('/api/parallel-research', parallelAILimiter, async (req, res) => {
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
// Note: GPT functions are now imported from services/gptService.js to avoid duplication
const { callGPT, synthesizeResults, safeParseJSON, craftSearchQueries } = require('./services/gptService');

// ===== CONTEXT FETCHING HELPERS =====
// Note: Google API functions (fetchGmailMessages, fetchDriveFiles, fetchDriveFileContents) 
// are now imported from services/googleApi.js to avoid duplication

/**
 * Extract keywords from meeting title and description
 * Used only by the old /api/prep-meeting-OLD endpoint (kept for reference)
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

// ===== MEETING PREP ENDPOINT (OLD - KEPT FOR REFERENCE) =====
// NOTE: This old endpoint is SHADOWED by the new routes/meetings.js endpoint
// The new multi-account endpoint is mounted above and will handle /api/prep-meeting requests
// This code is kept here for reference but will not be executed

app.post('/api/prep-meeting-OLD', async (req, res) => {
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

            // NEW: Domain-wide file query - search for files from attendee domains
            // Note: Drive API doesn't support domain-wide owner search directly
            // Instead, we'll use fullText search for domain names + aggressive keyword matching
            // This captures team documents mentioning the companies/domains
            const domainSearchTerms = [
                ...domains.map(d => d.split('.')[0]), // company names (e.g., "kordn8", "tonik")
                ...attendees.map(a => a.name ? a.name.split(' ')[0] : null).filter(Boolean) // First names
            ].filter(Boolean);

            const domainQuery = domainSearchTerms.length > 0
                ? `(${domainSearchTerms.map(term => `fullText contains '${term}'`).join(' or ')}) and modifiedTime > '${twoYearsAgo.toISOString()}'`
                : '';

            let nameQuery = '';
            if (keywords.length > 0) {
                const nameKeywords = keywords.map(k => `name contains '${k}'`).join(' or ');
                nameQuery = `(${nameKeywords}) and modifiedTime > '${twoYearsAgo.toISOString()}'`;
            }

            console.log(`  📁 Fetching Drive files with comprehensive domain-based queries...`);
            console.log(`     - Attendee permission-based files`);
            console.log(`     - Domain-wide files from: ${domains.join(', ')}`);
            console.log(`     - Keyword-based files: ${keywords.slice(0, 5).join(', ')}`);

            // Fetch permission-based, domain-wide, and keyword-based files in parallel
            // REMOVED CAPS: Fetch up to 200 files per query type for comprehensive coverage
            const [permFiles, domainFiles, nameFiles] = await Promise.all([
                fetchDriveFiles(accessToken, permQuery, 200),
                domainQuery ? fetchDriveFiles(accessToken, domainQuery, 200) : Promise.resolve([]),
                nameQuery ? fetchDriveFiles(accessToken, nameQuery, 200) : Promise.resolve([])
            ]);

            // Merge and deduplicate files by ID - include domain files
            const fileMap = new Map();
            [...permFiles, ...domainFiles, ...nameFiles].forEach(file => {
                if (!fileMap.has(file.id)) {
                    fileMap.set(file.id, file);
                }
            });
            files = Array.from(fileMap.values());

            console.log(`  ✓ Fetched ${files.length} unique Drive files`);
            console.log(`     - ${permFiles.length} from attendee permissions`);
            console.log(`     - ${domainFiles.length} from domain-wide search`);
            console.log(`     - ${nameFiles.length} from keyword matching`);

            // Fetch file contents for ALL files (no caps)
            if (files.length > 0) {
                files = await fetchDriveFileContents(accessToken, files);
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
                    `Analyze emails FROM ${name} (${att.email}) to extract professional context for meeting "${meeting.summary}".

CRITICAL SCOPE CLARIFICATION:
- These emails are ONLY those SENT BY ${name} (FROM: ${att.email})
- NOT emails that merely mention ${name} or are TO ${name}
- Extract insights about ${name}'s role, work, and communication from what THEY wrote

Extract and prioritize:
1. **Working relationship**: How do they collaborate with others? Who do they work with? Collaborative history?
2. **Current projects/progress**: What are they working on? Status updates they've shared? Blockers or wins?
3. **Role and expertise**: Their position, responsibilities, expertise (as demonstrated in their emails)
4. **Meeting-specific context**: References to this meeting's topic, agenda items, documents they shared
5. **Communication style**: Do they write detailed emails or brief ones? Technical or high-level?

VALIDATION:
- Only extract facts directly supported by ${name}'s emails
- Include email dates for context (e.g., "mentioned in Dec 15 email")
- Focus on information relevant to meeting "${meeting.summary}"
- Skip generic observations

OUTPUT FORMAT:
Return ONLY a JSON array of 3-6 specific facts. Each fact should be 15-80 words with concrete details.

GOOD EXAMPLES:
["Sent 'Kordn8 MVP Functions Report' on Nov 9 detailing current limitations in authentication and payment modules", "Requested approval on UX wireframes in Dec 15 email, indicating they're blocked on design decisions", "Communicates with technical detail - recent emails include code snippets and architecture diagrams"]

BAD EXAMPLES (do NOT generate):
["Works at Company X", "Experienced professional", "Team member on the project"]

If ${name}'s emails lack substantive professional context, return: []`,
                    attendeeEmails.slice(0, 15),
                    600
                );

                try {
                    const parsed = safeParseJSON(localSynthesis);
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
                        const parsed = safeParseJSON(webSynthesis);
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

        // NOTE: Summary generation moved to END of pipeline (after all analysis completes)
        // This ensures summary has access to deep email/document/relationship analysis

        // Generate email analysis - meeting-specific with DEEP analysis
        console.log(`  📧 Analyzing email threads for meeting context...`);
        let emailAnalysis = '';
        let relevantEmails = []; // Declare at higher scope for timeline use
        if (emails && emails.length > 0) {
            console.log(`  📊 Performing deep email analysis on ${emails.length} emails...`);

            // Filter emails to those relevant to THIS meeting - COMPREHENSIVE approach
            // Goal: Include ALL useful business context, no artificial time constraints
            console.log(`  🔍 Filtering ${emails.length} emails for meeting relevance (processing in batches of 50)...`);

            let allRelevantIndices = [];

            // Process emails in batches of 50 for relevance checking
            for (let batchStart = 0; batchStart < emails.length; batchStart += 50) {
                const batchEnd = Math.min(batchStart + 50, emails.length);
                const batchEmails = emails.slice(batchStart, batchEnd);

                console.log(`     Relevance check batch ${Math.floor(batchStart / 50) + 1}/${Math.ceil(emails.length / 50)} (${batchEmails.length} emails)...`);

                const relevanceCheck = await callGPT([{
                    role: 'system',
                    content: `You are filtering emails for meeting prep. Meeting: "${meeting.summary}"

COMPREHENSIVE FILTERING - Include ALL emails with relevance to understanding the full context.

✅ INCLUDE IF:
1. **Direct meeting relevance**: Email discusses this meeting's topic, agenda, or objectives
2. **Attendee correspondence**: Direct exchanges with meeting attendees about relevant work topics (NO TIME LIMIT - include historical context)
3. **Shared materials**: Documents, slides, or resources related to meeting topics
4. **Project context**: Updates about projects/initiatives related to this meeting
5. **Historical decisions**: Past decisions that provide context (include old emails if relevant)
6. **Working relationships**: Emails showing collaboration patterns between attendees
7. **Domain knowledge**: Emails from attendee domains discussing relevant topics

❌ EXCLUDE ONLY:
- Obvious spam, marketing newsletters, promotional emails
- Automated system notifications (CI/CD, calendar invites without content)
- Completely unrelated topics from different work streams

NO TIME CONSTRAINTS:
- OLD emails (>90 days) ARE VALUABLE for historical context - include them if relevant
- Focus on relevance to meeting topic, not recency
- Historical decisions and foundational discussions are crucial

COMPREHENSIVE OVER SELECTIVE:
- Include 60-80% of emails (err on the side of inclusion)
- When in doubt, INCLUDE - more context is better than missing context
- Each email helps build the full story

Return JSON with email indices to INCLUDE (relative to this batch):
{"relevant_indices": [0, 3, 7, ...]}

Example: For a "Q4 Budget Review" meeting, INCLUDE budget discussions from ANY time period, project cost discussions, resource allocation emails, AND general project updates that might have budget implications.`
                }, {
                    role: 'user',
                    content: `Emails to filter:\n${batchEmails.map((e, i) => `[${i}] Subject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}\nSnippet: ${e.snippet.substring(0, 200)}`).join('\n\n')}`
                }], 1000);

                let batchIndices = [];
                try {
                    const parsed = safeParseJSON(relevanceCheck);
                    batchIndices = (parsed.relevant_indices || []).map(idx => batchStart + idx);
                } catch (e) {
                    console.log(`  ⚠️  Failed to parse relevance check for batch, including all batch emails`);
                    batchIndices = batchEmails.map((_, i) => batchStart + i);
                }

                allRelevantIndices.push(...batchIndices);
                console.log(`     ✓ Found ${batchIndices.length}/${batchEmails.length} relevant emails in this batch`);
            }

            const relevantIndices = allRelevantIndices;
            console.log(`  🔍 Total relevant emails: ${relevantIndices.length}/${emails.length}`);

            if (relevantIndices.length === 0) {
                // No relevant emails found - use generic message
                // NOTE: We do NOT use fallback emails for timeline to avoid polluting it with irrelevant items
                console.log(`  ⚠️  No emails passed relevance filter for this meeting`);
                emailAnalysis = `No email threads found directly related to "${meeting.summary}". Email activity exists but appears to be general correspondence rather than meeting-specific discussion.`;
            } else {
                relevantEmails = relevantIndices.map(i => emails[i]).filter(Boolean);

                console.log(`  📊 Extracting context from ${relevantEmails.length} relevant emails (processing in batches of 20)...`);

                // PASS 1: Extract key topics, decisions, and action items - BATCH PROCESSING for unlimited emails
                let allExtractedData = [];

                for (let batchStart = 0; batchStart < relevantEmails.length; batchStart += 20) {
                    const batchEnd = Math.min(batchStart + 20, relevantEmails.length);
                    const batchEmails = relevantEmails.slice(batchStart, batchEnd);

                    console.log(`     Context extraction batch ${Math.floor(batchStart / 20) + 1}/${Math.ceil(relevantEmails.length / 20)} (${batchEmails.length} emails)...`);

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
                        content: `Emails:\n${batchEmails.map(e => `Subject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}\nBody: ${(e.body || e.snippet).substring(0, 3000)}`).join('\n\n---\n\n')}`
                    }], 1500);

                    try {
                        const batchData = safeParseJSON(topicsExtraction);
                        allExtractedData.push(batchData);
                    } catch (e) {
                        console.log(`  ⚠️  Failed to parse topics extraction for batch, continuing...`);
                    }
                }

                // Merge all batch results
                let extractedData = {
                    workingRelationships: [],
                    projectProgress: [],
                    blockers: [],
                    decisions: [],
                    actionItems: [],
                    topics: [],
                    keyContext: []
                };

                allExtractedData.forEach(batchData => {
                    if (batchData) {
                        Object.keys(extractedData).forEach(key => {
                            if (Array.isArray(batchData[key])) {
                                extractedData[key].push(...batchData[key]);
                            }
                        });
                    }
                });

                console.log(`  ✓ Extracted context: ${extractedData.workingRelationships.length} relationships, ${extractedData.decisions.length} decisions, ${extractedData.blockers.length} blockers`);

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
        let filesWithContent = []; // Declare at higher scope for timeline use
        if (files && files.length > 0) {
            // Filter files with content
            filesWithContent = files.filter(f => f.content && f.content.length > 100);

            if (filesWithContent.length > 0) {
                console.log(`  📊 Deep analysis of ALL ${filesWithContent.length} documents (processing in batches of 5)...`);

                // PASS 1: Extract key information from ALL documents - BATCH PROCESSING
                const allDocInsights = [];

                for (let i = 0; i < filesWithContent.length; i += 5) {
                    const batch = filesWithContent.slice(i, i + 5);
                    console.log(`     Document analysis batch ${Math.floor(i / 5) + 1}/${Math.ceil(filesWithContent.length / 5)} (${batch.length} files)...`);

                    const batchInsights = await Promise.all(
                        batch.map(async (file) => {
                            try {
                                const insight = await callGPT([{
                                    role: 'system',
                                    content: `Analyze this document for meeting "${meeting.summary}". Extract 3-10 KEY INSIGHTS.

Return JSON array of insights:
["insight 1", "insight 2", ...]

Each insight should:
- Be specific (include numbers, dates, names, decisions)
- Be 20-80 words
- Quote or reference specific content
- Explain relevance to the meeting

Focus on: decisions, data, action items, proposals, problems, solutions, timelines, strategic context.`
                                }, {
                                    role: 'user',
                                    content: `Document: "${file.name}"\n\nContent:\n${file.content.substring(0, 20000)}`
                                }], 1200);

                                const parsed = safeParseJSON(insight);
                                return { fileName: file.name, insights: Array.isArray(parsed) ? parsed : [] };
                            } catch (e) {
                                console.error(`  ⚠️  Error analyzing ${file.name}:`, e.message);
                                return { fileName: file.name, insights: [] };
                            }
                        })
                    );

                    allDocInsights.push(...batchInsights);
                }

                const docInsights = allDocInsights;
                console.log(`  ✓ Analyzed ${docInsights.length} documents, extracted insights from ${docInsights.filter(d => d.insights.length > 0).length} files`);

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
                companyData = safeParseJSON(companyExtraction);
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

            // Pass the prompt as a string and the data to analyze
            relationshipAnalysis = await synthesizeResults(
                relationshipPrompt,
                {
                    meetingTitle: meeting.summary,
                    emails: relevantEmails,
                    documents: filesWithContent,
                    attendees: attendees
                },
                1200
            );

            relationshipAnalysis = relationshipAnalysis?.trim() || 'Insufficient context to analyze working relationships. More email history or documents needed.';
            console.log(`  ✓ Relationship analysis: ${relationshipAnalysis.length} chars`);
        } else {
            relationshipAnalysis = 'No relationship context available - no email history found to analyze working dynamics.';
        }

        // ============================================================================
        // TIMELINE BUILDING - Extract RELEVANT interactions chronologically
        // ============================================================================
        console.log(`  📅 Building interaction timeline from relevant context...`);
        const timeline = [];

        // Use only RELEVANT emails for timeline (those that passed the meeting-specific filter)
        // This ensures timeline shows only interactions related to THIS meeting
        const timelineEmails = emailAnalysis && emailAnalysis !== 'No email activity found in the past 6 months.'
            ? (relevantEmails || [])
            : [];

        // Extract email events from RELEVANT emails only
        if (timelineEmails && timelineEmails.length > 0) {
            timelineEmails.forEach(email => {
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
            console.log(`    ✓ Added ${timelineEmails.length} relevant email events to timeline`);
        }

        // Extract document events from files WITH CONTENT (already filtered for relevance)
        const timelineFiles = filesWithContent || files?.filter(f => f.content) || [];
        if (timelineFiles && timelineFiles.length > 0) {
            timelineFiles.forEach(file => {
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
            const parsed = safeParseJSON(recommendations);
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
        const actionPrompt = `You are generating PREPARATION action items for the upcoming meeting: "${meeting.summary}"

CRITICAL DISTINCTION:
- These are PREP actions to do BEFORE the meeting (not actions TO TAKE during the meeting)
- Focus on what the user should review, prepare, or think about in advance
- Help them walk into the meeting fully prepared

FULL CONTEXT:
- Attendees: ${brief.attendees.map(a => `${a.name} (${a.keyFacts.join('; ')})`).join(' | ')}
- Email discussions: ${emailAnalysis}
- Document insights: ${documentAnalysis}
- Company context: ${companyResearch}
- Strategic recommendations: ${parsedRecommendations.join(' | ')}

STRICT REQUIREMENTS:
1. **Meeting-specific only**: Every action item must be DIRECTLY relevant to "${meeting.summary}"
   - ❌ BAD: "Schedule a follow-up meeting" (this is for AFTER the meeting)
   - ❌ BAD: "Review calendar for conflicts" (not specific to THIS meeting)
   - ✅ GOOD: "Review the 'Q4 Budget Report' mentioned in emails to prepare questions about line item 47"

2. **Reference specific context**: Each item must cite actual documents, emails, or data from the context
   - ❌ BAD: "Prepare talking points" (too vague)
   - ✅ GOOD: "Based on Sarah's Dec 15 email about delayed UX approval, prepare 3 specific wireframe options to discuss"

3. **Actionable prep tasks**: Focus on review, analysis, preparation (not in-meeting actions)
   - ✅ Examples: "Review document X", "Prepare questions about Y", "Analyze data from Z", "Think through approach for W"

4. **Detailed and specific**: 25-70 words each with concrete details
   - Include: what to review, why it matters, what to prepare
   - Reference: specific documents, emails (with dates), data points

5. **Quality filter**: Only include items that would GENUINELY help prepare for THIS meeting
   - If context is sparse, return 2-3 high-quality items rather than padding with generic ones
   - Skip obvious/generic prep like "be on time" or "review agenda"

OUTPUT FORMAT:
Return ONLY a JSON array of 3-6 action items (not more, not less).

GOOD EXAMPLES:
["Review the 'Kordn8 MVP Functions Detailed Report' shared by Akshay on Nov 9, focusing on sections 3-5 about current limitations, and prepare 2-3 specific questions about implementation priorities for the meeting discussion", "Analyze the 'Short Term User Stickiness' document (Dec 8) and prepare a brief perspective on which retention strategies align best with the team's current capacity constraints mentioned in recent emails"]

BAD EXAMPLES (do NOT generate):
["Attend the meeting on time", "Take notes during discussion", "Schedule follow-up meeting", "Review your calendar", "Prepare general talking points"]`;

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
            const parsed = safeParseJSON(actionResult);
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

        // ============================================================================
        // GENERATE EXECUTIVE SUMMARY - LAST STEP with full context
        // ============================================================================
        console.log(`\n  📊 Generating executive summary with complete context...`);

        brief.summary = await synthesizeResults(
            `You are creating an executive summary for the meeting: "${meeting.summary}"

CONTEXT: You have access to comprehensive analysis of emails, documents, attendee research, and company intelligence. Your task is to distill this into a compelling 3-4 sentence summary that truly prepares someone for this meeting.

CRITICAL REQUIREMENTS:

1. **Be SPECIFIC**: Reference actual people, documents, dates, or decisions from the analysis
   - ❌ BAD: "Team members will discuss the project"
   - ✅ GOOD: "Dobrochna (Tonik Product Lead) and Akshay (Kordn8 Engineering) will resolve..."

2. **Include TIMELINE CONTEXT**: Ground the meeting in recent history
   - ❌ BAD: "The meeting is about the roadmap"
   - ✅ GOOD: "Based on 23 email threads over 3 months..." or "Since the Dec 15 decision..."

3. **Reference CONCRETE ARTIFACTS**: Cite actual documents, emails, or data points
   - ❌ BAD: "Recent updates will be reviewed"
   - ✅ GOOD: "The 'Kordn8 MVP Functions Report' (Nov 9) details current limitations..."

4. **Highlight WORKING DYNAMICS**: Show the relationships and tensions (if any)
   - ❌ BAD: "Stakeholders will align on priorities"
   - ✅ GOOD: "The core tension is between feature velocity (Sarah's priority) and technical debt (Mike's concern)..."

5. **Connect to STRATEGIC CONTEXT**: Why does this meeting matter NOW?
   - ❌ BAD: "Progress will be discussed"
   - ✅ GOOD: "With the Jan 30 launch deadline approaching, this meeting is critical to..."

STRUCTURE (3-4 sentences):
- Sentence 1: WHO is meeting and WHAT is the core purpose (with specific context)
- Sentence 2: KEY CONTEXT from emails/docs that frames the discussion (cite specific sources)
- Sentence 3: CURRENT STATE and any tensions/blockers (from relationship analysis)
- Sentence 4 (optional): WHY THIS MATTERS NOW (timeline pressure, decisions needed)

GOOD EXAMPLE:
"This meeting brings together Dobrochna (Tonik Product Lead) and Akshay (Kordn8 Engineering) to finalize the Q4 MVP scope that has been under active discussion since their Nov 9 kickoff documented in the 'Kordn8 MVP Functions Detailed Report'. Based on 23 email threads over 3 months, the primary focus is completing the authentication module Akshay finished in January while resolving the UX design approval that has been pending since Akshay's Dec 15 wireframe submission. Their communication pattern shows collaborative but structured exchanges (2-3 emails/week), with Dobrochna providing strategic direction and Akshay handling implementation, though Akshay's Jan 8 request for a detailed agenda suggests he's seeking clarity on priorities. With the Feb product launch approaching, this meeting is critical to unblock the design approval bottleneck and align on the final feature set."

BAD EXAMPLE (too generic):
"This meeting is about discussing the Kordn8 project status. Team members will review recent progress and align on next steps. The attendees will discuss priorities and make decisions."

OUTPUT: Write 3-4 sentences following the structure above, using SPECIFIC details from the analysis to create a strategic briefing that would prepare someone to walk into this meeting with full context.`,
            {
                meeting: {
                    title: meeting.summary,
                    description: meeting.description || '',
                    startTime: meeting.start?.dateTime || meeting.start?.date || ''
                },
                attendees: brief.attendees.map(a => ({
                    name: a.name,
                    title: a.title,
                    company: a.company,
                    keyFacts: a.keyFacts?.slice(0, 3) || []
                })),
                emailAnalysis: emailAnalysis?.substring(0, 2000) || 'No email context available',
                documentAnalysis: documentAnalysis?.substring(0, 2000) || 'No document analysis available',
                companyResearch: companyResearch?.substring(0, 1500) || 'No company research available',
                relationshipAnalysis: relationshipAnalysis?.substring(0, 2000) || 'No relationship analysis available',
                recentTimeline: limitedTimeline.slice(0, 8).map(t => ({
                    date: t.date,
                    type: t.type,
                    description: t.description
                })),
                topRecommendations: parsedRecommendations.slice(0, 3)
            },
            600
        );

        console.log(`  ✓ Executive summary: ${brief.summary?.length || 0} chars`);

        // Assemble comprehensive brief
        brief.emailAnalysis = emailAnalysis;
        brief.documentAnalysis = documentAnalysis;
        brief.companyResearch = companyResearch;
        brief.relationshipAnalysis = relationshipAnalysis;
        brief.timeline = limitedTimeline;
        brief.recommendations = parsedRecommendations;
        brief.actionItems = parsedActionItems;

        console.log(`\n✅ Comprehensive brief generated with ${brief.attendees.length} attendees, ${limitedTimeline.length} timeline events`);
        res.json(brief);

    } catch (error) {
        console.error('Brief generation error:', error);
        res.status(500).json({
            error: 'Failed to generate brief',
            message: error.message
        });
    }
});

// Chat Panel REST endpoint (fallback if WebSocket unavailable)
const { requireAuth } = require('./middleware/auth');
app.post('/api/chat-panel', requireAuth, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        // Fetch today's meetings for context
        let meetings = [];
        try {
            const { fetchCalendarEvents } = require('./services/googleApi');
            const { getUserId } = require('./middleware/auth');
            const userId = getUserId(req);
            // TODO: Fetch user's meetings - for now, empty array
        } catch (error) {
            logger.error({ error: error.message }, 'Error fetching meetings for chat panel');
        }

        const response = await chatPanelService.generateResponse(message, [], meetings);
        res.json({ message: response });
    } catch (error) {
        logger.error({ error: error.message }, 'Error in chat panel endpoint');
        res.status(500).json({ error: 'Failed to generate response' });
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

            deepgramConnection.on('Transcript', async (data) => {
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

                dgConnection.on('Transcript', (data) => {
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

            // Voice Prep: Start 2-minute briefing
            else if (data.type === 'chat_panel_message') {
                console.log('💬 Chat panel message:', data.message);

                // Initialize conversation history if not exists
                if (!ws.chatPanelHistory) {
                    ws.chatPanelHistory = [];
                }

                // Add user message to history
                ws.chatPanelHistory.push({ role: 'user', content: data.message });

                // Fetch today's meetings for context
                let meetings = [];
                try {
                    const { fetchCalendarEvents } = require('./services/googleApi');
                    const { getUserId } = require('./middleware/auth');
                    const userId = getUserId(req);
                    // Note: We need access to req for user context, but WebSocket doesn't have req
                    // For now, we'll work without user-specific meetings
                    // TODO: Store user context in ws object during connection
                } catch (error) {
                    logger.error({ error: error.message }, 'Error fetching meetings for chat panel');
                }

                // Generate response
                chatPanelService.generateResponse(data.message, ws.chatPanelHistory, meetings)
                    .then(response => {
                        // Add assistant response to history
                        ws.chatPanelHistory.push({ role: 'assistant', content: response });

                        // Send response to client
                        ws.send(JSON.stringify({
                            type: 'chat_panel_response',
                            message: response
                        }));
                    })
                    .catch(error => {
                        logger.error({ error: error.message }, 'Error generating chat panel response');
                        ws.send(JSON.stringify({
                            type: 'chat_panel_response',
                            message: 'Sorry, I encountered an error. Please try again.'
                        }));
                    });
            }
            else if (data.type === 'voice_prep_start') {
                console.log('🎤 Starting voice prep briefing');

                if (!data.brief) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Meeting brief not provided'
                    }));
                    return;
                }

                // Get user context if available
                let userContext = null;
                if (userEmail) {
                    // Try to get user name from brief or construct from email
                    const userName = data.brief?.userName || userEmail.split('@')[0];
                    userContext = {
                        name: userName,
                        email: userEmail,
                        formattedName: userName,
                        formattedEmail: userEmail,
                        contextString: `${userName} (${userEmail})`,
                        emails: [userEmail]
                    };
                }
                
                // Create voice prep manager
                ws.voicePrepManager = new VoicePrepManager(
                    data.brief,
                    OPENAI_API_KEY,
                    userContext
                );

                // Connect the manager to the WebSocket
                await ws.voicePrepManager.connect(ws);

                console.log('✅ Voice prep briefing initialized');
            }

            // Voice Prep: Audio data streaming
            else if (data.type === 'voice_prep_audio') {
                if (ws.voicePrepManager) {
                    const audioChunk = Buffer.from(data.audio, 'base64');
                    // sendAudio will auto-commit when >= 100ms of audio is accumulated
                    ws.voicePrepManager.sendAudio(audioChunk);
                } else {
                    console.warn('⚠️  Voice prep briefing not initialized');
                }
            }
            
            // Voice Prep: Commit audio buffer (explicit commit from client - e.g., on silence)
            // NOTE: With server_vad, OpenAI handles commits automatically, so this is rarely needed
            else if (data.type === 'voice_prep_audio_commit') {
                if (ws.voicePrepManager && ws.voicePrepManager.realtimeManager) {
                    // Only commit if audio was actually sent and we have enough buffered
                    ws.voicePrepManager.commitAudioBuffer();
                }
            }

            // Voice Prep: Stop
            else if (data.type === 'voice_prep_stop') {
                console.log('🛑 Stopping voice prep briefing');
                
                // With server_vad, OpenAI handles commits automatically
                // We don't need to manually commit on stop - OpenAI will flush any remaining audio
                // Attempting to commit manually often fails because OpenAI already committed
                // So we skip manual commit and just disconnect
                
                if (ws.voicePrepManager) {
                    ws.voicePrepManager.disconnect();
                    ws.voicePrepManager = null;
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
                model: 'gpt-5',
                messages: [{
                    role: 'system',
                    content: `You are a real-time meeting assistant. Your job is to provide CRITICAL, HIGH-VALUE suggestions ONLY when absolutely necessary.

STRICT QUALITY THRESHOLD:
- Default to returning EMPTY array {"suggestions": []}
- Only suggest when you have CRITICAL information that would significantly change the conversation
- Maximum 1-2 suggestions per analysis (prefer 0-1)
- Think: "Would I interrupt a CEO's meeting to say this?" If no, don't suggest it.

WHEN TO SUGGEST (rare cases only):
1. **Factual Correction**: User states something demonstrably false from meeting context
   - ✅ Example: User says "Sarah leads engineering" but context shows she's in design
   - ❌ Counter-example: User says "I think it's around 50%" (casual uncertainty is OK)

2. **Critical Missing Context**: User is unaware of CRUCIAL information that will derail the conversation
   - ✅ Example: User discussing project timeline, but context shows project was cancelled last week
   - ❌ Counter-example: "FYI, attendee John works at Company X" (nice-to-know, not critical)

3. **Direct Question to AI**: User explicitly asks for information
   - ✅ Example: "What was the budget we agreed on?"
   - ❌ Counter-example: Rhetorical questions or thinking out loud

NEVER SUGGEST:
- Generic observations ("seems uncertain", "clarify roles")
- Obvious facts user just stated ("Yes, India has 1.4B people")
- Casual hedge words ("I think", "maybe" - this is normal speech!)
- Background info unless it's CRITICAL to current discussion
- Suggestions about communication style or meeting dynamics
- Anything that isn't IMMEDIATELY actionable

Meeting Context (COMPACT):
Meeting: ${context?.summary || 'Unknown'}
Attendees: ${context?.attendees?.map(a => a.name).join(', ') || 'Unknown'}

DECISION PROCESS:
1. Read the transcript carefully
2. Ask: "Is there a CRITICAL factual error or missing information?"
3. Ask: "Would this suggestion SIGNIFICANTLY change the outcome?"
4. Ask: "Is this worth interrupting the conversation?"
5. If any answer is "no" → return empty array

OUTPUT FORMAT:
{"suggestions": [{"type": "correction|critical_context", "message": "...", "severity": "warning|error"}]}

TONE: Direct, specific, cite sources. Example: "According to the Nov 15 email, the budget was $50k, not $30k."

DEFAULT: Return {"suggestions": []} unless you have CRITICAL information.`
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
            const parsed = safeParseJSON(content);
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
                model: 'gpt-5',
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
                        model: 'gpt-5',
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

// Start server with database validation
async function startServer() {
    logger.info('Testing database connection...');

    try {
        // Use centralized database connection module
        const { testConnection } = require('./db/connection');
        const connected = await testConnection();

        if (!connected) {
            logger.warn('Database connection test failed - server will start but database features may not work');
            console.error('\n⚠️  WARNING: Database connection failed');
            console.error('   Server will start, but features requiring database will not work.');
            console.error('   Fix the connection issue and restart the server.\n');
            // Don't exit - allow server to start for development/testing
        } else {
            logger.info('Database connection successful');
        }

    } catch (error) {
        logger.error({ error: error.message }, 'Database connection error');
        console.error('⚠️  Database connection error - server will start anyway');
        console.error('   Please check your SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env file');
        console.error('   Or run migrations: node db/runMigrations.js\n');
        // Don't exit - allow server to start for development/testing
    }

    server.listen(PORT, () => {
        logger.info({
            port: PORT,
            parallelApiConfigured: !!process.env.PARALLEL_API_KEY,
            deepgramConfigured: !!process.env.DEEPGRAM_API_KEY,
            supabaseConnected: true
        }, 'Server started');
        
        // Also log to console for visibility
        console.log(`\n🚀 Server running on http://localhost:${PORT}`);
        console.log(`📡 Parallel AI API key: ${process.env.PARALLEL_API_KEY ? '✓ Configured' : '✗ Missing'}`);
        console.log(`🎤 Deepgram API key: ${process.env.DEEPGRAM_API_KEY ? '✓ Configured' : '✗ Missing'}`);
        console.log(`💾 Supabase database: ✓ Connected`);
        console.log(`\nAvailable endpoints:`);
        console.log(`  POST /auth/google/callback     - OAuth sign-in`);
        console.log(`  POST /auth/google/add-account  - Add account`);
        console.log(`  GET  /auth/me                  - Current user`);
        console.log(`  GET  /api/accounts             - List accounts`);
        console.log(`  POST /api/prep-meeting         - Multi-account meeting prep`);
        console.log(`  POST /api/parallel-search      - Web search`);
        console.log(`  POST /api/parallel-extract     - Extract from URLs`);
        console.log(`  POST /api/parallel-research    - Deep research tasks`);
        console.log(`  WS   /ws/meeting-stream        - Real-time meeting assistant`);
        console.log(`  GET  /health                   - Health check\n`);
    });
}

// Error handling middleware - must be last
const { errorHandler } = require('./middleware/errorHandler');
app.use(errorHandler);

// Start session cleanup service
const { startPeriodicCleanup } = require('./services/sessionCleanup');
const CLEANUP_INTERVAL_HOURS = parseInt(process.env.SESSION_CLEANUP_INTERVAL_HOURS || '6', 10);
startPeriodicCleanup(CLEANUP_INTERVAL_HOURS);

startServer().catch(error => {
    logger.fatal({ error }, 'Fatal error starting server');
    process.exit(1);
});
