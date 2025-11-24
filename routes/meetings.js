/**
 * Meeting Preparation Routes
 *
 * Multi-account meeting preparation endpoint that fetches context from ALL connected accounts
 */

const express = require('express');
const router = express.Router();

const { getAccountsByUserId } = require('../db/queries/accounts');
const { optionalAuth } = require('../middleware/auth');
const { validateMeetingPrep } = require('../middleware/validation');
const { meetingPrepLimiter } = require('../middleware/rateLimiter');
const { ensureAllTokensValid } = require('../services/tokenRefresh');
const { fetchAllAccountContext, fetchCalendarFromAllAccounts, mergeAndDeduplicateCalendarEvents } = require('../services/multiAccountFetcher');
const { callGPT, synthesizeResults, safeParseJSON, sleep } = require('../services/gptService');
const { getUserContext, filterUserFromAttendees, getPromptPrefix } = require('../services/userContext');

/**
 * POST /api/prep-meeting
 * Prepare for a meeting by gathering context from all connected accounts
 *
 * Supports both:
 * - NEW: Multi-account session-based (authenticated users)
 * - OLD: Single-account token-based (backward compatibility)
 */
const logger = require('../services/logger');

router.post('/prep-meeting', meetingPrepLimiter, optionalAuth, validateMeetingPrep, async (req, res) => {
    const requestId = req.requestId || 'unknown';
    
    try {
        const { meeting, attendees, accessToken } = req.body;

        // Handle Google Calendar format: meeting.summary or meeting.title
        const meetingTitle = meeting.summary || meeting.title || 'Untitled Meeting';
        // Normalize meeting object to always have summary
        if (!meeting.summary && meeting.title) {
            meeting.summary = meeting.title;
        }
        
        // Extract and format meeting date/time for temporal context
        function formatMeetingDate(meeting) {
            const start = meeting.start?.dateTime || meeting.start?.date || meeting.start;
            if (!start) return null;
            
            try {
                const date = new Date(start);
                if (isNaN(date.getTime())) return null;
                
                const now = new Date();
                const diffMs = date.getTime() - now.getTime();
                const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                
                let relative = '';
                if (diffDays < 0) {
                    relative = `${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? 's' : ''} ago`;
                } else if (diffDays === 0) {
                    relative = 'today';
                } else if (diffDays === 1) {
                    relative = 'tomorrow';
                } else {
                    relative = `in ${diffDays} days`;
                }
                
                return {
                    iso: date.toISOString(),
                    readable: date.toLocaleDateString('en-US', { 
                        weekday: 'long',
                        month: 'long', 
                        day: 'numeric', 
                        year: 'numeric' 
                    }),
                    time: date.toLocaleTimeString('en-US', { 
                        hour: 'numeric', 
                        minute: '2-digit',
                        hour12: true 
                    }),
                    relative: relative,
                    date: date
                };
            } catch (e) {
                return null;
            }
        }
        
        const meetingDate = formatMeetingDate(meeting);
        const meetingDateContext = meetingDate 
            ? `\n\nIMPORTANT TEMPORAL CONTEXT: This meeting is scheduled for ${meetingDate.readable} at ${meetingDate.time} (${meetingDate.relative}). Today is ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}. Focus on information relevant to THIS specific meeting on ${meetingDate.readable}, not past meetings with similar names or topics.`
            : '';
        
        // Get user context for prompts
        const userContext = await getUserContext(req);
        
        logger.info({
            requestId,
            meetingTitle,
            meetingDate: meetingDate?.readable || 'unknown',
            attendeeCount: attendees?.length || 0,
            hasAccessToken: !!accessToken,
            userId: req.userId || 'anonymous',
            userName: userContext?.name || 'unknown'
        }, 'Starting meeting prep request');
        
        console.log(`\n📋 Preparing brief for: ${meetingTitle}${userContext ? ` (User: ${userContext.name})` : ''}`);
        
        // Filter user from attendees list (user shouldn't research themselves)
        const otherAttendees = userContext ? filterUserFromAttendees(attendees || [], userContext) : (attendees || []);
        console.log(`👥 Attendees: ${attendees?.length || 0} total, ${otherAttendees.length} others (excluding user)`);

        const brief = {
            summary: '',
            attendees: [],
            companies: [],
            actionItems: [],
            context: '',
            _multiAccountStats: null // Will contain stats if multi-account mode is used
        };

        let emails = [];
        let files = [];
        let calendarEvents = [];
        let accounts = [];
        const includeCalendar = req.body.includeCalendar !== false; // Default: true

        // ===== MULTI-ACCOUNT MODE (NEW) =====
        if (req.userId) {
            console.log(`🔐 Multi-account mode: User ${req.user.email}`);

            // Get all connected accounts for this user
            accounts = await getAccountsByUserId(req.userId);
            console.log(`📧 Found ${accounts.length} connected account(s)`);

            if (accounts.length === 0) {
                return res.status(400).json({
                    error: 'No connected accounts',
                    message: 'Please connect at least one Google account'
                });
            }

            // Ensure all accounts have valid tokens (auto-refresh if needed)
            const tokenValidationResult = await ensureAllTokensValid(accounts);

            if (tokenValidationResult.validAccounts.length === 0) {
                // Check if all failures are due to revoked tokens
                const allRevoked = tokenValidationResult.failedAccounts.every(f => f.isRevoked);
                
                return res.status(401).json({
                    error: allRevoked ? 'TokenRevoked' : 'TokenRefreshFailed',
                    message: allRevoked 
                        ? 'Your session has expired. Please sign in again.'
                        : 'Failed to refresh tokens for your accounts. Please re-authenticate.',
                    revoked: allRevoked,
                    failedAccounts: tokenValidationResult.failedAccounts.map(f => ({
                        email: f.accountEmail,
                        error: f.error,
                        isRevoked: f.isRevoked
                    })),
                    requestId: req.requestId
                });
            }

            // If some accounts failed but we have valid ones, continue but warn user
            if (tokenValidationResult.partialSuccess) {
                console.warn(`⚠️  Partial account failure: ${tokenValidationResult.failedAccounts.length} account(s) failed, continuing with ${tokenValidationResult.validAccounts.length} account(s)`);
            }

            accounts = tokenValidationResult.validAccounts;

            // Fetch context from ALL accounts in parallel
            const contextPromises = [
                fetchAllAccountContext(accounts, attendees, meeting)
            ];

            // Optionally include calendar events
            if (includeCalendar && attendees && attendees.length > 0) {
                contextPromises.push(fetchCalendarFromAllAccounts(accounts, attendees, meeting));
            }

            const results = await Promise.all(contextPromises);
            const { emails: allEmails, files: allFiles, accountStats } = results[0];

            emails = allEmails;
            files = allFiles;
            brief._multiAccountStats = accountStats;

            // Warn user if partial failure occurred
            if (accountStats.partialFailure) {
                console.warn(`⚠️  Partial account failure: Some accounts failed but continuing with available data`);
                // Include warning in response
                brief._partialFailure = true;
                brief._failedAccounts = accountStats.failedAccounts;
            }

            // Merge calendar events if fetched
            if (results.length > 1) {
                const calendarResults = results[1];
                const calendarResultsArray = Array.isArray(calendarResults) ? calendarResults : (calendarResults.results || []);
                calendarEvents = mergeAndDeduplicateCalendarEvents(calendarResultsArray);
            }

            console.log(`✅ Multi-account context gathered: ${emails.length} emails, ${files.length} files, ${calendarEvents.length} calendar events`);
        }
        // ===== SINGLE-ACCOUNT MODE (OLD - BACKWARD COMPATIBILITY) =====
        else if (accessToken) {
            console.log(`🔑 Single-account mode (legacy): Using provided access token`);

            // Validate legacy access token format (basic validation)
            if (typeof accessToken !== 'string' || accessToken.length < 50) {
                return res.status(400).json({
                    error: 'Invalid access token',
                    message: 'Access token format is invalid'
                });
            }

            // Import Google API functions for backward compatibility
            const { fetchGmailMessages, fetchDriveFiles, fetchDriveFileContents } = require('../services/googleApi');

            if (attendees && attendees.length > 0) {
                // Handle Google Calendar format: a.email or a.emailAddress
                const attendeeEmails = attendees.map(a => a.email || a.emailAddress).filter(Boolean);
                const domains = [...new Set(attendeeEmails.map(e => e.split('@')[1]))];

                // Fetch from 2 years back
                const twoYearsAgo = new Date();
                twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
                const afterDate = twoYearsAgo.toISOString().split('T')[0].replace(/-/g, '/');

                // Build Gmail query
                const attendeeQueries = attendeeEmails.map(email => `from:${email} OR to:${email}`).join(' OR ');
                const domainQueries = domains.map(d => `from:*@${d}`).join(' OR ');
                const gmailQuery = `(${attendeeQueries} OR ${domainQueries}) after:${afterDate}`;

                console.log(`📧 Fetching emails...`);
                emails = await fetchGmailMessages(accessToken, gmailQuery, 100);
                console.log(`✓ Fetched ${emails.length} emails`);

                // Build Drive query
                const permQueries = attendeeEmails.map(email => `'${email}' in readers or '${email}' in writers`).join(' or ');
                const permQuery = `(${permQueries}) and modifiedTime > '${twoYearsAgo.toISOString()}'`;

                console.log(`📁 Fetching Drive files...`);
                const driveFiles = await fetchDriveFiles(accessToken, permQuery, 200);
                console.log(`✓ Found ${driveFiles.length} Drive files`);

                if (driveFiles.length > 0) {
                    files = await fetchDriveFileContents(accessToken, driveFiles);
                }
            }

            console.log(`✅ Single-account context gathered: ${emails.length} emails, ${files.length} files`);
        }
        // ===== NO AUTHENTICATION =====
        else {
            return res.status(401).json({
                error: 'Authentication required',
                message: 'Please sign in or provide an access token'
            });
        }

        // ===== AI ANALYSIS (ORIGINAL INLINE LOGIC from server.js) =====
        // Deep relevance filtering → batch processing → comprehensive analysis
        console.log(`\n🧠 Running original inline AI analysis...`);

        try {
            // ===== STEP 1: RESEARCH ATTENDEES =====
            console.log(`\n👥 Researching attendees...`);
            // Use filtered attendees (excluding user)
            const attendeesToResearch = otherAttendees.length > 0 ? otherAttendees : attendees;
            console.log(`   Researching ${attendeesToResearch.length} attendee(s) (excluding user)`);
            
            // Process all attendees (removed limit of 6)
            // If more than 10 attendees, process in batches to avoid overwhelming
            const maxConcurrentAttendees = 10;
            const attendeeBatches = [];
            for (let i = 0; i < attendeesToResearch.length; i += maxConcurrentAttendees) {
                attendeeBatches.push(attendeesToResearch.slice(i, i + maxConcurrentAttendees));
            }
            
            let allAttendeeResults = [];
            for (const batch of attendeeBatches) {
                const attendeePromises = batch.map(async (att) => {
                // Handle Google Calendar format: att.email or att.emailAddress
                const attendeeEmail = att.email || att.emailAddress;
                if (!attendeeEmail) {
                    console.log(`  ⏭️  Skipping attendee without email: ${JSON.stringify(att)}`);
                    return null;
                }

                const domain = attendeeEmail.split('@')[1];
                const company = domain.split('.')[0];

                // Skip resource calendars
                if (attendeeEmail.includes('@resource.calendar.google.com')) {
                    console.log(`  ⏭️  Skipping resource calendar: ${att.displayName || attendeeEmail}`);
                    return null;
                }

                let name = att.displayName || attendeeEmail.split('@')[0];
                console.log(`  🔍 Researching: ${name} (${attendeeEmail})`);

                let keyFacts = [];
                let title = company;
                let source = 'local';

                // Extract full name from email headers if needed
                const attendeeEmails = emails ? emails.filter(e =>
                    e.from?.toLowerCase().includes(attendeeEmail.toLowerCase())
                ) : [];

                if (attendeeEmails.length > 0 && (!att.displayName || !att.displayName.includes(' '))) {
                    const fromHeader = attendeeEmails[0].from;
                    const nameMatch = fromHeader?.match(/^([^<]+)(?=\s*<)/);
                    if (nameMatch && nameMatch[1].trim()) {
                        const extractedName = nameMatch[1].trim().replace(/"/g, '');
                        if (extractedName.includes(' ') || extractedName.length > name.length) {
                            console.log(`    📛 Extracted full name from email: "${extractedName}"`);
                            name = extractedName;
                        }
                    }
                }

                // Extract context from emails THEY sent AND emails TO them
                const emailsToAttendee = emails ? emails.filter(e =>
                    e.to?.toLowerCase().includes(attendeeEmail.toLowerCase())
                ) : [];
                
                // Combine emails FROM and TO attendee, deduplicate by ID
                const allAttendeeEmails = [...attendeeEmails, ...emailsToAttendee];
                const uniqueAttendeeEmails = Array.from(
                    new Map(allAttendeeEmails.map(e => [e.id, e])).values()
                );
                
                if (uniqueAttendeeEmails.length > 0) {
                    console.log(`    📧 Found ${attendeeEmails.length} emails from ${name}, ${emailsToAttendee.length} emails to ${name} (${uniqueAttendeeEmails.length} total unique)`);
                    
                    // Prepare email data for synthesis (ensure proper structure)
                    const emailDataForSynthesis = uniqueAttendeeEmails.slice(0, 20).map(e => ({
                        subject: e.subject || '',
                        from: e.from || '',
                        to: e.to || '',
                        date: e.date || '',
                        body: e.body || e.snippet || '',
                        snippet: e.snippet || ''
                    }));
                    
                    // Fallback: Extract basic info from emails even if synthesis fails
                    const fallbackFacts = [];
                    if (emailDataForSynthesis.length > 0) {
                        // Extract company from email domain
                        const emailDomain = attendeeEmail.split('@')[1];
                        if (emailDomain && emailDomain !== 'gmail.com' && emailDomain !== 'yahoo.com' && emailDomain !== 'outlook.com') {
                            const companyName = emailDomain.split('.')[0];
                            fallbackFacts.push(`Works at ${companyName.charAt(0).toUpperCase() + companyName.slice(1)}`);
                        }
                        
                        // Extract any project names or key terms from email subjects
                        const subjects = emailDataForSynthesis.map(e => e.subject || '').join(' ').toLowerCase();
                        const projectKeywords = ['project', 'meeting', 'report', 'proposal', 'plan', 'launch'];
                        const foundKeywords = projectKeywords.filter(kw => subjects.includes(kw));
                        if (foundKeywords.length > 0) {
                            fallbackFacts.push(`Involved in ${foundKeywords[0]} communications`);
                        }
                        
                        // Add communication frequency
                        if (uniqueAttendeeEmails.length >= 10) {
                            fallbackFacts.push(`Frequent collaborator (${uniqueAttendeeEmails.length} email exchanges)`);
                        }
                    }
                    
                    logger.info({ 
                        requestId: req.requestId, 
                        attendeeEmail, 
                        emailCount: emailDataForSynthesis.length,
                        fallbackFactsCount: fallbackFacts.length
                    }, 'Synthesizing attendee email context');
                    
                    const userContextStr = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
                    const localSynthesis = await synthesizeResults(
                        `${userContextStr}Analyze emails FROM ${name} (${attendeeEmail}) to extract professional context for meeting "${meetingTitle}".${meetingDateContext}

${userContext ? `IMPORTANT: Extract information that ${userContext.formattedName} should know about ${name}. Structure facts from ${userContext.formattedName}'s perspective.` : ''}

CRITICAL SCOPE: These emails include both emails SENT BY ${name} (FROM: ${attendeeEmail}) AND emails SENT TO ${name} (TO: ${attendeeEmail}). This provides a complete view of their communication patterns.

Extract and prioritize:
1. **Working relationship**: ${userContext ? `How does ${name} collaborate with ${userContext.formattedName} and others?` : 'How do they collaborate with others?'}
2. **Current projects/progress**: What are they working on?
3. **Role and expertise**: Their position, responsibilities
4. **Meeting-specific context**: References to this meeting's topic
5. **Communication style**: How they communicate

OUTPUT FORMAT: Return ONLY a valid JSON array. CRITICAL: Must be valid JSON, no markdown code blocks, no explanations.

REQUIREMENTS:
- Return at least 1-2 facts even from limited context
- Each fact should be 15-80 words with concrete details
- Focus on: role, company, recent communications, any project mentions, collaboration patterns
- Extract ANY relevant information that ${userContext ? userContext.formattedName : 'the user'} should know about ${name}

GOOD EXAMPLES:
["Sent 'Kordn8 MVP Functions Report' on Nov 9 detailing current limitations", "Requested approval on UX wireframes in Dec 15 email", "Regularly coordinates with team on product roadmap"]

BAD EXAMPLES (do NOT generate):
["Works at Company X", "Experienced professional"]

If emails are very limited, extract at least: their role/company, frequency of communication, any project names mentioned.`,
                        emailDataForSynthesis,
                        700 // Increased tokens for more emails
                    );

                    if (localSynthesis) {
                        // Log raw synthesis result for debugging
                        logger.info({ 
                            requestId: req.requestId, 
                            attendeeEmail, 
                            synthesisLength: localSynthesis.length,
                            synthesisRaw: localSynthesis.substring(0, 500) // Log first 500 chars
                        }, 'Raw email synthesis result');
                        
                        try {
                            const parsed = safeParseJSON(localSynthesis);
                            logger.info({ 
                                requestId: req.requestId, 
                                attendeeEmail, 
                                parsedType: typeof parsed,
                                isArray: Array.isArray(parsed),
                                parsedLength: Array.isArray(parsed) ? parsed.length : 'N/A',
                                parsedSample: Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : parsed
                            }, 'Email synthesis parse result');
                            
                            if (Array.isArray(parsed) && parsed.length > 0) {
                                keyFacts = parsed.filter(f => f && typeof f === 'string' && f.length > 10);
                                console.log(`    ✓ Extracted ${keyFacts.length} facts from emails`);
                            } else {
                                logger.warn({ requestId: req.requestId, attendeeEmail, parsed, rawSynthesis: localSynthesis.substring(0, 300) }, 'Email synthesis returned empty or invalid array');
                                console.log(`    ⚠️  Email synthesis returned empty array`);
                                // Use fallback facts if synthesis failed
                                if (fallbackFacts.length > 0) {
                                    keyFacts = fallbackFacts;
                                    console.log(`    ✓ Using ${fallbackFacts.length} fallback facts from email metadata`);
                                }
                            }
                        } catch (e) {
                            logger.error({ 
                                requestId: req.requestId, 
                                attendeeEmail, 
                                error: e.message, 
                                errorStack: e.stack,
                                synthesis: localSynthesis.substring(0, 500) 
                            }, 'Failed to parse email synthesis');
                            console.log(`    ⚠️  Failed to parse email synthesis: ${e.message}`);
                            // Use fallback facts if parsing failed
                            if (fallbackFacts.length > 0) {
                                keyFacts = fallbackFacts;
                                console.log(`    ✓ Using ${fallbackFacts.length} fallback facts from email metadata`);
                            }
                        }
                    } else {
                        logger.warn({ requestId: req.requestId, attendeeEmail }, 'Email synthesis returned null');
                        console.log(`    ⚠️  Email synthesis returned null`);
                        // Use fallback facts if synthesis returned null
                        if (fallbackFacts.length > 0) {
                            keyFacts = fallbackFacts;
                            console.log(`    ✓ Using ${fallbackFacts.length} fallback facts from email metadata`);
                        }
                    }
                }

                // Web search via Parallel API
                if (req.parallelClient) {
                    console.log(`    🌐 Performing web search...`);
                    try {
                        const queries = [
                            `"${name}" site:linkedin.com ${domain}`,
                            `"${name}" ${company} site:linkedin.com`,
                            `"${name}" "${attendeeEmail}"`
                        ];

                        const searchResult = await req.parallelClient.beta.search({
                            objective: `Find LinkedIn profile and professional info for ${name} who works at ${company} (${attendeeEmail})`,
                            search_queries: queries,
                            mode: 'one-shot',
                            max_results: 8,
                            max_chars_per_result: 2500
                        });

                        if (searchResult.results && searchResult.results.length > 0) {
                            // Filter and validate results
                            // 1. Check if name matches (person validation)
                            // 2. Check company/email matches
                            const companyNameOnly = company.toLowerCase();
                            const nameLower = name.toLowerCase();
                            const nameWords = name.split(' ').filter(w => w.length > 2); // Filter out short words
                            
                            const validatedResults = searchResult.results.filter(r => {
                                const textToSearch = `${r.title || ''} ${r.excerpt || ''} ${r.url || ''}`.toLowerCase();
                                
                                // Person validation: check if name appears in result
                                const nameMatch = nameWords.length > 0 && nameWords.some(word => 
                                    textToSearch.includes(word.toLowerCase())
                                );
                                
                                // Company/email match
                                const companyMatch = textToSearch.includes(companyNameOnly);
                                const emailMatch = textToSearch.includes(attendeeEmail.toLowerCase());
                                
                                // Require name match OR (company/email match)
                                return nameMatch || (companyMatch || emailMatch);
                            });
                            
                            // If no validated results, try less strict (name only)
                            const relevantResults = validatedResults.length > 0 ? validatedResults : 
                                searchResult.results.filter(r => {
                                    const textToSearch = `${r.title || ''} ${r.excerpt || ''} ${r.url || ''}`.toLowerCase();
                                    return nameWords.some(word => textToSearch.includes(word.toLowerCase()));
                                });
                            
                            // Fallback to all results if still empty
                            const resultsToUse = relevantResults.length > 0 ? relevantResults : searchResult.results.slice(0, 3);

                            if (resultsToUse.length > 0) {
                                console.log(`    ✓ Found ${resultsToUse.length} relevant web results`);
                                
                                logger.info({ 
                                    requestId: req.requestId, 
                                    attendeeEmail, 
                                    resultCount: resultsToUse.length 
                                }, 'Synthesizing web search results');
                                
                                const userContextStr = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
                                const webSynthesis = await synthesizeResults(
                                    `${userContextStr}Extract professional information about ${name} (${attendeeEmail}) for meeting "${meetingTitle}"${meetingDateContext}. Focus on information that ${userContext ? userContext.formattedName : 'the user'} should know about this attendee's role and background.

CRITICAL OUTPUT FORMAT: Return ONLY a valid JSON array. No markdown code blocks, no explanations, no narrative text. Just the JSON array.

EXAMPLE FORMAT:
["Fact 1 about their role or background", "Fact 2 about their work or expertise", "Fact 3 about relevant experience"]

REQUIREMENTS:
- Return at least 1-2 facts even if information is limited
- Each fact should be 15-80 words
- Focus on: current role, company, expertise, relevant background, LinkedIn profile highlights
- Extract ANY relevant professional information that would help ${userContext ? userContext.formattedName : 'the user'} understand this attendee

Return JSON array of 3-6 facts (15-80 words each).`,
                                    resultsToUse.slice(0, 5), // Increased from 3 to 5 results
                                    600 // Increased tokens for more results
                                );

                                if (webSynthesis) {
                                    // Log raw synthesis result for debugging
                                    logger.info({ 
                                        requestId: req.requestId, 
                                        attendeeEmail, 
                                        synthesisLength: webSynthesis.length,
                                        synthesisRaw: webSynthesis.substring(0, 500) // Log first 500 chars
                                    }, 'Raw web synthesis result');
                                    
                                    try {
                                        const webParsed = safeParseJSON(webSynthesis);
                                        logger.info({ 
                                            requestId: req.requestId, 
                                            attendeeEmail, 
                                            parsedType: typeof webParsed,
                                            isArray: Array.isArray(webParsed),
                                            parsedLength: Array.isArray(webParsed) ? webParsed.length : 'N/A',
                                            parsedSample: Array.isArray(webParsed) && webParsed.length > 0 ? webParsed[0] : webParsed
                                        }, 'Web synthesis parse result');
                                        
                                        if (Array.isArray(webParsed) && webParsed.length > 0) {
                                            const newFacts = webParsed.filter(f => f && typeof f === 'string' && f.length > 10);
                                            keyFacts.push(...newFacts);
                                            source = keyFacts.length > 0 ? 'local+web' : 'web';
                                            console.log(`    ✓ Extracted ${newFacts.length} facts from web search`);
                                        } else {
                                            logger.warn({ requestId: req.requestId, attendeeEmail, parsed: webParsed, rawSynthesis: webSynthesis.substring(0, 300) }, 'Web synthesis returned empty or invalid array');
                                            console.log(`    ⚠️  Web synthesis returned empty array`);
                                        }
                                    } catch (e) {
                                        logger.error({ 
                                            requestId: req.requestId, 
                                            attendeeEmail, 
                                            error: e.message, 
                                            errorStack: e.stack,
                                            synthesis: webSynthesis.substring(0, 500) 
                                        }, 'Failed to parse web synthesis');
                                        console.log(`    ⚠️  Could not parse web results: ${e.message}`);
                                    }
                                } else {
                                    logger.warn({ requestId: req.requestId, attendeeEmail }, 'Web synthesis returned null');
                                    console.log(`    ⚠️  Web synthesis returned null`);
                                }
                            }
                        }
                    } catch (webError) {
                        console.error(`    ⚠️  Web search failed:`, webError.message);
                    }
                }

                // Ensure keyFacts is always an array and has at least basic info if empty
                let finalKeyFacts = keyFacts.slice(0, 6);
                
                // Fallback: If no keyFacts found, add basic information
                if (finalKeyFacts.length === 0) {
                    finalKeyFacts = [
                        `Works at ${company} (${domain})`,
                        `Email: ${attendeeEmail}`
                    ];
                    source = 'basic';
                }
                
                return {
                    name: name,
                    email: attendeeEmail,
                    company: company,
                    title: title || `${company} team member`,
                    keyFacts: finalKeyFacts,
                    dataSource: source
                };
                });
                
                const batchResults = (await Promise.all(attendeePromises)).filter(a => a !== null);
                allAttendeeResults.push(...batchResults);
            }
            
            brief.attendees = allAttendeeResults;
            console.log(`  ✓ Processed ${brief.attendees.length} attendees`);

            // ===== STEP 2: EMAIL RELEVANCE FILTERING + BATCH EXTRACTION =====
            console.log(`\n  📧 Analyzing email threads for meeting context...`);
            let emailAnalysis = '';
            let relevantEmails = [];

            if (emails && emails.length > 0) {
                console.log(`  🔍 Filtering ${emails.length} emails for meeting relevance (processing in batches of 50)...`);

                let allRelevantIndices = [];

                // PASS 1: Relevance filtering in batches of 25 (reduced for better accuracy)
                for (let batchStart = 0; batchStart < emails.length; batchStart += 25) {
                    const batchEnd = Math.min(batchStart + 25, emails.length);
                    const batchEmails = emails.slice(batchStart, batchEnd);

                    console.log(`     Relevance check batch ${Math.floor(batchStart / 25) + 1}/${Math.ceil(emails.length / 25)} (${batchEmails.length} emails)...`);

                    const userContextPrefix = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
                    const relevanceCheck = await callGPT([{
                        role: 'system',
                        content: `${userContextPrefix}You are filtering emails for meeting prep. Meeting: "${meetingTitle}"${meetingDateContext}

${userContext ? `IMPORTANT: ${userContext.formattedName} is the user you are preparing this brief for. Filter emails that are relevant to ${userContext.formattedName}'s understanding of this meeting.` : ''}

COMPREHENSIVE FILTERING - Include ALL emails with relevance to understanding the full context.

✅ INCLUDE IF:
1. **Direct meeting relevance**: Email discusses this meeting's topic, agenda, or objectives
2. **Attendee correspondence**: Direct exchanges with meeting attendees about relevant work topics${userContext ? ` (including ${userContext.formattedName}'s own emails if they provide context)` : ''}
3. **Shared materials**: Documents, slides, or resources related to meeting topics
4. **Project context**: Updates about projects/initiatives related to this meeting
5. **Historical decisions**: Past decisions that provide context
6. **Working relationships**: Emails showing collaboration patterns between attendees${userContext ? ` (including ${userContext.formattedName}'s relationships with others)` : ''}
7. **Domain knowledge**: Emails from attendee domains discussing relevant topics

❌ EXCLUDE ONLY:
- Obvious spam, marketing newsletters, promotional emails
- Automated system notifications (CI/CD, calendar invites without content)
- Completely unrelated topics from different work streams

DATE PRIORITIZATION: Prioritize emails from the last 30 days, but include older emails if highly relevant. Recent emails provide more current context, while older emails provide valuable historical context.

ATTENDEE PRIORITIZATION: Prioritize emails with multiple meeting attendees (higher attendee count = more relevant to meeting context).

COMPREHENSIVE OVER SELECTIVE: Include 60-80% of emails (err on the side of inclusion), but weight recent emails and emails with more attendees higher in your decision

Return JSON with email indices to INCLUDE (relative to this batch):
{"relevant_indices": [0, 3, 7, ...]}`,
                    }, {
                        role: 'user',
                        content: `Emails to filter:\n${batchEmails.map((e, i) => {
                            const bodyPreview = (e.body || e.snippet || '').substring(0, 2000);
                            const snippet = e.snippet?.substring(0, 200) || '';
                            const daysAgo = e.date ? Math.floor((new Date() - new Date(e.date)) / (1000 * 60 * 60 * 24)) : 'unknown';
                            // Count attendees in email (from + to fields)
                            const fromEmail = e.from?.toLowerCase() || '';
                            const toEmails = (e.to || '').toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
                            const allEmailsInMessage = [fromEmail, ...toEmails];
                            const attendeeEmails = attendees.map(a => (a.email || a.emailAddress)?.toLowerCase()).filter(Boolean);
                            const attendeeCount = allEmailsInMessage.filter(email => attendeeEmails.some(attEmail => email.includes(attEmail))).length;
                            return `[${i}] Subject: ${e.subject}\nFrom: ${e.from}\nTo: ${e.to || 'N/A'}\nDate: ${e.date} (${daysAgo} days ago)\nAttendee Count: ${attendeeCount} meeting attendees\nSnippet: ${snippet}\nBody Preview: ${bodyPreview}${bodyPreview.length >= 2000 ? '...[truncated]' : ''}`;
                        }).join('\n\n')}`
                    }], 1000);

                    let batchIndices = [];
                    try {
                        const parsed = safeParseJSON(relevanceCheck);
                        batchIndices = (parsed.relevant_indices || []).map(idx => batchStart + idx);
                    } catch (e) {
                        logger.error({
                            requestId: req.requestId,
                            error: e.message,
                            batchStart: batchStart,
                            batchSize: batchEmails.length,
                            meetingTitle: meetingTitle
                        }, 'Failed to parse email relevance check - excluding batch from analysis');
                        console.log(`  ⚠️  Failed to parse relevance check for batch ${Math.floor(batchStart / 25) + 1}, excluding from analysis`);
                        // Stricter fallback: include none on failure (prevents irrelevant emails)
                        batchIndices = [];
                    }

                    allRelevantIndices.push(...batchIndices);
                    console.log(`     ✓ Found ${batchIndices.length}/${batchEmails.length} relevant emails in this batch`);

                    // Rate limiting: wait 5 seconds between batches (OpenAI TPM limit: 30k tokens/min)
                    if (batchStart + 25 < emails.length) {
                        await sleep(5000);
                    }
                }

                console.log(`  ✓ Total relevant emails: ${allRelevantIndices.length}/${emails.length}`);

                if (allRelevantIndices.length === 0) {
                    emailAnalysis = `No email threads found directly related to "${meetingTitle}"${meetingDate ? ` (scheduled for ${meetingDate.readable})` : ''}.`;
                } else {
                    relevantEmails = allRelevantIndices.map(i => emails[i]).filter(Boolean);
                    
                    // Group emails by thread (subject + key participants)
                    const threadMap = new Map();
                    relevantEmails.forEach(email => {
                        const subject = email.subject || 'No Subject';
                        const from = email.from?.toLowerCase() || '';
                        const to = email.to?.toLowerCase() || '';
                        // Create thread key from subject (normalized) and participants
                        const threadKey = subject.toLowerCase().replace(/^(re:|fwd?:|fw:)\s*/i, '').trim();
                        const participants = [from, ...(to.split(',').map(e => e.trim().toLowerCase()))].filter(Boolean).sort().join('|');
                        const fullThreadKey = `${threadKey}::${participants}`;
                        
                        if (!threadMap.has(fullThreadKey)) {
                            threadMap.set(fullThreadKey, {
                                subject: subject,
                                emails: [],
                                participants: new Set(),
                                dateRange: { earliest: null, latest: null }
                            });
                        }
                        
                        const thread = threadMap.get(fullThreadKey);
                        thread.emails.push(email);
                        if (from) thread.participants.add(from);
                        to.split(',').forEach(e => {
                            const emailAddr = e.trim().toLowerCase();
                            if (emailAddr) thread.participants.add(emailAddr);
                        });
                        
                        const emailDate = email.date ? new Date(email.date) : null;
                        if (emailDate) {
                            if (!thread.dateRange.earliest || emailDate < thread.dateRange.earliest) {
                                thread.dateRange.earliest = emailDate;
                            }
                            if (!thread.dateRange.latest || emailDate > thread.dateRange.latest) {
                                thread.dateRange.latest = emailDate;
                            }
                        }
                    });
                    
                    // Add thread metadata to emails for context extraction
                    relevantEmails = relevantEmails.map(email => {
                        const subject = email.subject || 'No Subject';
                        const from = email.from?.toLowerCase() || '';
                        const to = email.to?.toLowerCase() || '';
                        const threadKey = subject.toLowerCase().replace(/^(re:|fwd?:|fw:)\s*/i, '').trim();
                        const participants = [from, ...(to.split(',').map(e => e.trim().toLowerCase()))].filter(Boolean).sort().join('|');
                        const fullThreadKey = `${threadKey}::${participants}`;
                        const thread = threadMap.get(fullThreadKey);
                        
                        return {
                            ...email,
                            _threadInfo: thread ? {
                                messageCount: thread.emails.length,
                                participants: Array.from(thread.participants),
                                dateRange: thread.dateRange
                            } : null
                        };
                    });
                    
                    console.log(`  📧 Grouped into ${threadMap.size} email threads`);

                    console.log(`  📊 Extracting context from ${relevantEmails.length} relevant emails (processing in batches of 20)...`);

                    // PASS 2: Extract context in batches of 20
                    let allExtractedData = [];

                    for (let batchStart = 0; batchStart < relevantEmails.length; batchStart += 20) {
                        const batchEnd = Math.min(batchStart + 20, relevantEmails.length);
                        const batchEmails = relevantEmails.slice(batchStart, batchEnd);

                        console.log(`     Context extraction batch ${Math.floor(batchStart / 20) + 1}/${Math.ceil(relevantEmails.length / 20)} (${batchEmails.length} emails)...`);

                        const userContextPrefix = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
                        const topicsExtraction = await callGPT([{
                            role: 'system',
                            content: `${userContextPrefix}Deeply analyze these emails to extract ALL relevant context for meeting "${meetingTitle}"${meetingDateContext}

${userContext ? `IMPORTANT: ${userContext.formattedName} is the user you are preparing this brief for. Structure all analysis from ${userContext.formattedName}'s perspective. When referring to ${userContext.formattedName}, use "you" or "${userContext.formattedName}".` : ''}

CRITICAL: Focus on RELATIONSHIPS, PROGRESS, and BLOCKERS - not just topics.

NOTE: Emails may include thread metadata (_threadInfo) showing conversation flow, participant count, and date range. Use this to understand context better.

Return a detailed JSON object:
{
  "workingRelationships": ["${userContext ? userContext.formattedName + "'s" : "The user's"} relationships with others? Collaborative history? Authority/decision-making dynamics?"],
  "projectProgress": ["What's been accomplished? Current status? Timeline mentions? Milestones?"],
  "blockers": ["What's blocking progress? Unresolved questions? Pending decisions? Dependencies?"],
  "decisions": ["What decisions have been made? By whom? When? Impact?"],
  "actionItems": ["${userContext ? "What does " + userContext.formattedName + " need to do? What do others need to do?" : "Who needs to do what?"} By when? Current status?"],
  "topics": ["Main discussion topics, agenda items, key themes"],
  "keyContext": ["Other important context: document references, past meetings, external dependencies"],
  "attachments": ["Email attachments mentioned or referenced (filename, type, relevance)"],
  "sentiment": ["Communication tone: collaborative, tense, urgent, positive, negative, neutral. Flag any conflict indicators."]
}

Be THOROUGH and SPECIFIC: Include names, dates, document references, patterns across emails.
Each point should be 15-80 words with concrete details. Structure everything from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective.`,
                        }, {
                            role: 'user',
                            content: `Emails:\n${batchEmails.map(e => {
                                const body = e.body || e.snippet || '';
                                // Use first 6000 + last 2000 chars for better context preservation
                                const bodyPreview = body.length > 8000 
                                    ? body.substring(0, 6000) + '\n\n[...middle content truncated...]\n\n' + body.substring(body.length - 2000)
                                    : body;
                                const threadInfo = e._threadInfo ? `\nThread Info: ${e._threadInfo.messageCount} messages, ${e._threadInfo.participants.length} participants, ${e._threadInfo.dateRange.earliest ? 'from ' + e._threadInfo.dateRange.earliest.toLocaleDateString() : ''} to ${e._threadInfo.dateRange.latest ? e._threadInfo.dateRange.latest.toLocaleDateString() : ''}` : '';
                                const attachmentInfo = e.attachments && e.attachments.length > 0 
                                    ? `\nAttachments: ${e.attachments.map(a => `${a.filename} (${a.mimeType}, ${a.size} bytes)`).join(', ')}`
                                    : '';
                                return `Subject: ${e.subject}\nFrom: ${e.from}\nDate: ${e.date}${threadInfo}${attachmentInfo}\nBody: ${bodyPreview}`;
                            }).join('\n\n---\n\n')}`
                        }], 1500);

                        try {
                            const batchData = safeParseJSON(topicsExtraction);
                            allExtractedData.push(batchData);
                        } catch (e) {
                            console.log(`  ⚠️  Failed to parse topics extraction for batch`);
                        }

                        // Rate limiting: wait 5 seconds between batches (OpenAI TPM limit: 30k tokens/min)
                        if (batchStart + 20 < relevantEmails.length) {
                            await sleep(5000);
                        }
                    }

                    // Merge all batch results with deduplication
                    let extractedData = {
                        workingRelationships: [],
                        projectProgress: [],
                        blockers: [],
                        decisions: [],
                        actionItems: [],
                        topics: [],
                        keyContext: [],
                        attachments: []
                    };

                    // Helper function to check similarity (simple string similarity)
                    function isSimilar(str1, str2) {
                        if (!str1 || !str2) return false;
                        const s1 = str1.toLowerCase().substring(0, 100);
                        const s2 = str2.toLowerCase().substring(0, 100);
                        // Check if one contains the other (80% overlap)
                        return s1.includes(s2.substring(0, Math.floor(s2.length * 0.8))) || 
                               s2.includes(s1.substring(0, Math.floor(s1.length * 0.8)));
                    }

                    // Deduplication function
                    function deduplicateArray(arr) {
                        const seen = [];
                        return arr.filter(item => {
                            if (!item || typeof item !== 'string') return false;
                            const isDup = seen.some(seenItem => isSimilar(item, seenItem));
                            if (!isDup) {
                                seen.push(item);
                                return true;
                            }
                            return false;
                        });
                    }

                    allExtractedData.forEach(batchData => {
                        if (batchData) {
                            Object.keys(extractedData).forEach(key => {
                                if (Array.isArray(batchData[key])) {
                                    extractedData[key].push(...batchData[key]);
                                }
                            });
                        }
                    });

                    // Deduplicate all arrays
                    Object.keys(extractedData).forEach(key => {
                        extractedData[key] = deduplicateArray(extractedData[key]);
                    });
                    
                    const totalBeforeDedup = Object.values(extractedData).reduce((sum, arr) => sum + arr.length, 0);
                    console.log(`  ✓ Deduplicated extracted data: ${totalBeforeDedup} items → ${Object.values(extractedData).reduce((sum, arr) => sum + arr.length, 0)} unique items`);

                    console.log(`  ✓ Extracted context: ${extractedData.workingRelationships.length} relationships, ${extractedData.decisions.length} decisions, ${extractedData.blockers.length} blockers`);

                    // PASS 3: Synthesize into narrative
                    // Estimate token count (rough: 1 token ≈ 4 chars)
                    const extractedDataStr = JSON.stringify(extractedData, null, 2);
                    const estimatedTokens = Math.ceil(extractedDataStr.length / 4);
                    const tokenBudget = 8000; // GPT-4o context window is large, but we want to leave room
                    const needsTruncation = estimatedTokens > tokenBudget;
                    
                    const userContextPrefix = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
                    const emailSummary = await callGPT([{
                        role: 'system',
                        content: `${userContextPrefix}You are creating a comprehensive email analysis for meeting prep. Synthesize the extracted data into a detailed, insightful paragraph (8-12 sentences).

${userContext ? `IMPORTANT: Structure this analysis from ${userContext.formattedName}'s perspective. Use "you" to refer to ${userContext.formattedName}. Focus on what ${userContext.formattedName} needs to know.` : ''}

${needsTruncation ? `NOTE: Data has been truncated to fit token budget. Prioritize most recent and most relevant information.` : ''}

Extracted Data:
${needsTruncation ? extractedDataStr.substring(0, tokenBudget * 4) + '\n\n[...data truncated for token budget...]' : extractedDataStr}

CRITICAL PRIORITIES (in order):
1. **Working Relationships**: ${userContext ? `Start with ${userContext.formattedName}'s relationships with others and how people work together` : 'Start with HOW people work together'}
2. **Progress & Status**: What's been accomplished? What's the current state?
3. **Blockers & Issues**: What's preventing progress?
4. **Decisions & Actions**: What's been decided? ${userContext ? `What does ${userContext.formattedName} need to do? What do others need to do?` : 'Who needs to do what?'}
5. **Context**: Documents, past meetings, external factors

Guidelines:
- Write as if briefing ${userContext ? userContext.formattedName : 'an executive'} before a critical meeting
- Be SPECIFIC: include names, dates, document names, numbers
- Connect dots: show cause-effect, before-after, who-said-what
- Avoid generic statements - say HOW and WHY
- Every sentence must add actionable insight
- Use "you" to refer to ${userContext ? userContext.formattedName : 'the user'}`,
                    }, {
                        role: 'user',
                        content: `Meeting: ${meetingTitle}${meetingDateContext}\n\nCreate comprehensive email analysis paragraph.`
                    }], 800);

                    emailAnalysis = emailSummary?.trim() || 'Limited email context available.';
                    console.log(`  ✓ Email analysis: ${emailAnalysis.length} chars from ${relevantEmails.length} relevant emails`);
                }
            } else {
                emailAnalysis = 'No email activity found.';
            }

            // ===== STEP 3: DOCUMENT ANALYSIS IN BATCHES OF 5 =====
            console.log(`\n  📄 Analyzing document content for meeting relevance...`);
            let documentAnalysis = '';
            let filesWithContent = [];

            if (files && files.length > 0) {
                // Filter and prioritize documents
                // 1. Filter out image files, prioritize text-based documents
                const textBasedFiles = files.filter(f => {
                    if (!f.content || f.content.length < 100) return false;
                    const mimeType = f.mimeType || '';
                    // Skip images
                    if (mimeType.startsWith('image/')) return false;
                    // Prioritize: Google Docs, Sheets, PDFs, Word docs, text files
                    return mimeType.includes('document') || 
                           mimeType.includes('spreadsheet') || 
                           mimeType.includes('pdf') || 
                           mimeType.includes('text') ||
                           mimeType.includes('word');
                });
                
                // 2. Sort by modification date (recent first)
                textBasedFiles.sort((a, b) => {
                    const dateA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
                    const dateB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
                    return dateB - dateA; // Most recent first
                });
                
                // 3. Prioritize documents shared with more attendees
                const attendeeEmails = attendees.map(a => a.email || a.emailAddress).filter(Boolean);
                textBasedFiles.sort((a, b) => {
                    const aOwnerMatch = a.ownerEmail && attendeeEmails.includes(a.ownerEmail.toLowerCase());
                    const bOwnerMatch = b.ownerEmail && attendeeEmails.includes(b.ownerEmail.toLowerCase());
                    if (aOwnerMatch && !bOwnerMatch) return -1;
                    if (!aOwnerMatch && bOwnerMatch) return 1;
                    return 0;
                });
                
                filesWithContent = textBasedFiles;

                if (filesWithContent.length > 0) {
                    console.log(`  📊 Deep analysis of ${filesWithContent.length} prioritized documents (processing in batches of 5)...`);

                    const allDocInsights = [];

                    for (let i = 0; i < filesWithContent.length; i += 5) {
                        const batch = filesWithContent.slice(i, i + 5);
                        console.log(`     Document analysis batch ${Math.floor(i / 5) + 1}/${Math.ceil(filesWithContent.length / 5)} (${batch.length} files)...`);

                        const batchInsights = await Promise.all(
                            batch.map(async (file) => {
                                try {
                                    const insight = await callGPT([{
                                        role: 'system',
                                        content: `Analyze this document for meeting "${meetingTitle}"${meetingDateContext}. Extract 3-10 KEY INSIGHTS.

Document Type: ${file.mimeType || 'unknown'}
Document Modified: ${file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : 'unknown'}

Return JSON array of insights: ["insight 1", "insight 2", ...]

Each insight should:
- Be specific (include numbers, dates, names, decisions)
- Be 20-80 words
- Quote or reference specific content
- Explain relevance to the meeting

Focus on: decisions, data, action items, proposals, problems, solutions, timelines, strategic context.`,
                                    }, {
                                        role: 'user',
                                        content: `Document: "${file.name}"\n\nContent:\n${file.content.substring(0, 30000)}${file.content.length > 30000 ? '\n\n[Document truncated - showing first 30k chars]' : ''}`
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

                        // Rate limiting: wait 5 seconds between batches (OpenAI TPM limit: 30k tokens/min)
                        if (i + 5 < filesWithContent.length) {
                            await sleep(5000);
                        }
                    }

                    console.log(`  ✓ Analyzed ${allDocInsights.length} documents`);

                    const allInsights = allDocInsights.filter(d => d.insights.length > 0);

                    if (allInsights.length > 0) {
                        const userContextPrefix = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
                        const docNarrative = await callGPT([{
                            role: 'system',
                            content: `${userContextPrefix}You are creating a comprehensive document analysis for meeting prep. Synthesize these document insights into a detailed paragraph (6-12 sentences) from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective.

Document Insights:
${JSON.stringify(allInsights, null, 2)}

Guidelines:
- Organize by importance and relevance to meeting "${meetingTitle}"${meetingDate ? ` on ${meetingDate.readable}` : ''}
- Prioritize most recent and most relevant information first
- Reference specific documents by name
- Include concrete details: numbers, dates, decisions, proposals
- Connect insights across documents if relevant
- Focus on actionable information for the meeting
- Remove duplicate insights across documents`,
                        }, {
                            role: 'user',
                            content: `Create comprehensive document analysis for meeting: ${meetingTitle}`
                        }], 1000);

                        documentAnalysis = docNarrative?.trim() || 'Document analysis in progress.';
                        console.log(`  ✓ Document analysis: ${documentAnalysis.length} chars from ${allInsights.length} docs`);
                    } else {
                        documentAnalysis = `Analyzed ${filesWithContent.length} documents but found limited content directly relevant to "${meetingTitle}"${meetingDate ? ` (scheduled for ${meetingDate.readable})` : ''}.`;
                    }
                } else if (files.length > 0) {
                    documentAnalysis = `Found ${files.length} potentially relevant documents: ${files.map(f => f.name).slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}. Unable to access full content.`;
                }
            } else {
                documentAnalysis = 'No relevant documents found.';
            }

            // ===== STEP 4: COMPANY RESEARCH (placeholder - can expand later) =====
            const companyResearch = 'Company context available from emails and documents.';

            // ===== STEP 5: RELATIONSHIP ANALYSIS =====
            console.log(`\n  🤝 Analyzing working relationships...`);
            let relationshipAnalysis = '';

            if (relevantEmails.length > 0 || filesWithContent.length > 0) {
                // Include raw data samples for more specific insights
                const sampleEmails = relevantEmails.slice(0, 10).map(e => ({
                    subject: e.subject,
                    from: e.from,
                    to: e.to,
                    date: e.date,
                    bodyPreview: (e.body || e.snippet || '').substring(0, 500)
                }));
                
                const sampleDocs = filesWithContent.slice(0, 3).map(f => ({
                    name: f.name,
                    contentPreview: (f.content || '').substring(0, 2000),
                    modifiedTime: f.modifiedTime
                }));
                
                // Calculate interaction frequency metrics
                const interactionFrequency = {};
                brief.attendees.forEach(attendee => {
                    const attendeeEmail = (attendee.email || '').toLowerCase();
                    if (!attendeeEmail) return;
                    
                    const emailCount = relevantEmails.filter(e => {
                        const from = (e.from || '').toLowerCase();
                        const to = (e.to || '').toLowerCase();
                        return from.includes(attendeeEmail) || to.includes(attendeeEmail);
                    }).length;
                    
                    const docCount = filesWithContent.filter(f => {
                        const owner = (f.ownerEmail || '').toLowerCase();
                        return owner === attendeeEmail;
                    }).length;
                    
                    interactionFrequency[attendee.name] = {
                        emailInteractions: emailCount,
                        documentCollaborations: docCount,
                        totalInteractions: emailCount + docCount
                    };
                });
                
                const userContextStr = userContext ? `\n\nIMPORTANT: ${userContext.formattedName} (${userContext.formattedEmail}) is the user you are preparing this brief for. Analyze relationships from ${userContext.formattedName}'s perspective. Focus on ${userContext.formattedName}'s relationships with others, not relationships between other attendees.` : '';
                const relationshipPrompt = `${userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : ''}Meeting: ${meetingTitle}${meetingDateContext}

${userContext ? `User: ${userContext.formattedName} (${userContext.formattedEmail})` : ''}
Other Attendees: ${brief.attendees.map(a => `${a.name} (${a.email})`).join(', ')}${userContextStr}

INTERACTION FREQUENCY METRICS:
${JSON.stringify(interactionFrequency, null, 2)}

EMAIL ANALYSIS SUMMARY:
${emailAnalysis}

DOCUMENT ANALYSIS SUMMARY:
${documentAnalysis}

RAW DATA SAMPLES (use these for specific examples and quotes):

Sample Emails (${sampleEmails.length}):
${JSON.stringify(sampleEmails, null, 2)}

Sample Documents (${sampleDocs.length}):
${JSON.stringify(sampleDocs, null, 2)}

Your task is to deeply analyze the WORKING RELATIONSHIPS${userContext ? ` between ${userContext.formattedName} and the other attendees` : ' between these people'}.
Use the interaction frequency metrics to understand communication patterns.
Use the raw data samples above for specific examples, quotes, and concrete details.
Use the summaries for overall context and patterns.

1. **${userContext ? `How does ${userContext.formattedName} know each attendee?` : 'How do they know each other?'}** - Collaborative history, projects, duration
2. **What is ${userContext ? `${userContext.formattedName}'s` : 'their'} working dynamic with each attendee?** - Who makes decisions? Communication patterns? Trust level?
3. **What are the power dynamics?** - Authority? Hierarchy? Who drives the agenda?
4. **Are there any unresolved issues or tensions?** - Pending decisions? Blockers? Disagreements?

Write a comprehensive 8-12 sentence analysis from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective. Be SPECIFIC: Reference actual emails with dates, mention specific documents, quote key exchanges. Use "you" to refer to ${userContext ? userContext.formattedName : 'the user'}.`;

                relationshipAnalysis = await synthesizeResults(
                    relationshipPrompt,
                    {
                        meetingTitle: meetingTitle,
                        emails: relevantEmails,
                        documents: filesWithContent,
                        attendees: attendees
                    },
                    1200
                );

                relationshipAnalysis = relationshipAnalysis?.trim() || 'Insufficient context to analyze working relationships.';
                console.log(`  ✓ Relationship analysis: ${relationshipAnalysis.length} chars`);
            } else {
                relationshipAnalysis = 'No relationship context available.';
            }

            // ===== STEP 5: DEEP CONTRIBUTION ANALYSIS =====
            console.log(`\n  👥 Analyzing contributions and roles...`);
            let contributionAnalysis = '';
            
            if (brief.attendees.length > 0 && (relevantEmails.length > 0 || filesWithContent.length > 0)) {
                // Analyze who is contributing what and how
                const contributionData = {
                    emails: relevantEmails.slice(0, 50).map(e => ({
                        from: e.from,
                        to: e.to,
                        subject: e.subject,
                        date: e.date,
                        bodyPreview: (e.body || e.snippet || '').substring(0, 500),
                        attachments: e.attachments || []
                    })),
                    documents: filesWithContent.slice(0, 20).map(f => ({
                        name: f.name,
                        owner: f.owner,
                        modifiedTime: f.modifiedTime,
                        contentPreview: f.content ? f.content.substring(0, 1000) : '',
                        sharedWith: f.sharedWith || []
                    })),
                    calendarEvents: calendarEvents.slice(0, 20).map(e => ({
                        summary: e.summary,
                        attendees: e.attendees || [],
                        start: e.start,
                        description: e.description || ''
                    })),
                    attendees: brief.attendees.map(a => ({
                        name: a.name,
                        email: a.email,
                        company: a.company,
                        keyFacts: a.keyFacts || []
                    }))
                };
                
                const userContextPrefix = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
                const contributionAnalysisRaw = await callGPT([{
                    role: 'system',
                    content: `${userContextPrefix}You are analyzing contributions and roles for meeting "${meetingTitle}"${meetingDateContext}.

${userContext ? `IMPORTANT: ${userContext.formattedName} is the user you are preparing this brief for. Analyze contributions from ${userContext.formattedName}'s perspective. Focus on what ${userContext.formattedName} has contributed and how others contribute relative to ${userContext.formattedName}.` : ''}

Your goal: Deeply understand WHO is contributing WHAT and HOW.

Analyze:
1. **Individual Contributions**: What has each person contributed? (emails sent, documents created/shared, decisions made, questions asked)${userContext ? ` Focus especially on ${userContext.formattedName}'s contributions.` : ''}
2. **Contribution Patterns**: Who initiates? Who responds? Who drives decisions? Who provides information?
3. **Areas of Expertise**: What does each person specialize in? What topics do they discuss?
4. **Influence & Authority**: Who has decision-making power? Who influences others? Who gets things done?
5. **Collaboration Patterns**: ${userContext ? `How does ${userContext.formattedName} collaborate with others?` : 'Who works together?'} How do they collaborate? What are the working relationships?
6. **Gaps & Missing Contributions**: ${userContext ? `What should ${userContext.formattedName} contribute?` : 'Who should be contributing but isn\'t?'} What perspectives are missing?

Return detailed JSON:
{
  "contributions": {
    "person1@email.com": {
      "name": "Person Name",
      "contributions": ["Specific contribution 1", "Specific contribution 2"],
      "role": "What role do they play?",
      "expertise": ["Area 1", "Area 2"],
      "influence": "High/Medium/Low - why?",
      "patterns": "How do they contribute? (initiator, responder, decision-maker, etc.)"
    }
  },
  "collaborationNetworks": ["${userContext ? userContext.formattedName + "'s" : 'Who'} works with whom and how"],
  "decisionMakers": ["Who makes decisions and on what"],
  "informationFlow": "How does information flow? Who shares what with whom?",
  "gaps": ["${userContext ? `What should ${userContext.formattedName} contribute?` : 'What contributions are missing?'} What perspectives are needed?"]
}`
                }, {
                    role: 'user',
                    content: `Meeting: "${meetingTitle}"${meetingDateContext}
Meeting Description: ${meeting.description || 'No description'}

${userContext ? `User: ${userContext.formattedName} (${userContext.formattedEmail})` : ''}
Other Attendees: ${brief.attendees.map(a => `${a.name} (${a.email})`).join(', ')}

Email Data:
${JSON.stringify(contributionData.emails, null, 2)}

Document Data:
${JSON.stringify(contributionData.documents, null, 2)}

Calendar Data:
${JSON.stringify(contributionData.calendarEvents, null, 2)}

Analyze contributions deeply.`
                }], 2000);

                try {
                    const parsed = safeParseJSON(contributionAnalysisRaw);
                    if (parsed && typeof parsed === 'object') {
                        // Convert to narrative format
                        const userContextPrefix2 = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
                        contributionAnalysis = await callGPT([{
                            role: 'system',
                            content: `${userContextPrefix2}Convert this contribution analysis into a comprehensive narrative paragraph (8-12 sentences) that explains who contributes what and how, structured from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective. Use "you" to refer to ${userContext ? userContext.formattedName : 'the user'}.`
                        }, {
                            role: 'user',
                            content: `Contribution Analysis:\n${JSON.stringify(parsed, null, 2)}\n\nCreate narrative explaining contributions and roles from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective.`
                        }], 1000);
                    } else {
                        contributionAnalysis = contributionAnalysisRaw;
                    }
                } catch (e) {
                    console.error(`  ⚠️  Failed to parse contribution analysis: ${e.message}`);
                    contributionAnalysis = contributionAnalysisRaw || 'Contribution analysis in progress.';
                }
                
                contributionAnalysis = contributionAnalysis?.trim() || 'Contribution analysis in progress.';
                console.log(`  ✓ Contribution analysis: ${contributionAnalysis.length} chars`);
            } else {
                contributionAnalysis = 'Insufficient data to analyze contributions.';
            }

            // ===== STEP 6: BROADER NARRATIVE SYNTHESIS =====
            console.log(`\n  📖 Building broader narrative understanding...`);
            let broaderNarrative = '';
            
            if (emailAnalysis || documentAnalysis || relationshipAnalysis) {
                const userContextPrefix6 = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
                broaderNarrative = await callGPT([{
                    role: 'system',
                    content: `${userContextPrefix6}You are synthesizing the BROADER NARRATIVE for meeting "${meetingTitle}"${meetingDateContext} from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective.

${userContext ? `IMPORTANT: ${userContext.formattedName} is the user you are preparing this brief for. Structure the narrative from ${userContext.formattedName}'s perspective. Use "you" to refer to ${userContext.formattedName}.` : ''}

Your goal: Understand the complete story - not just what happened, but WHY things happened, HOW they connect, and WHAT it all means for ${userContext ? userContext.formattedName : 'the user'}.

Synthesize:
1. **The Story Arc**: What is the journey that led to this meeting? What were the key events, decisions, and turning points?
2. **The Context**: What broader context surrounds this meeting? (projects, initiatives, organizational changes, external factors)
3. **The Stakes**: Why does this meeting matter for ${userContext ? userContext.formattedName : 'the user'}? What are the consequences of success or failure?
4. **The Dynamics**: How do all the pieces fit together? How do emails, documents, relationships, and contributions connect?
5. **The Unanswered Questions**: What questions remain? What needs to be resolved?
6. **The Trajectory**: Where is this heading? What's the likely outcome? What needs to happen next?

Write a comprehensive narrative (10-15 sentences) that tells the complete story from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective. Make it compelling and insightful. Use "you" to refer to ${userContext ? userContext.formattedName : 'the user'}.`
                }, {
                    role: 'user',
                    content: `Meeting: "${meetingTitle}"${meetingDateContext}
Meeting Description: ${meeting.description || 'No description'}

${userContext ? `User: ${userContext.formattedName} (${userContext.formattedEmail})` : ''}

Email Analysis:
${emailAnalysis}

Document Analysis:
${documentAnalysis}

Relationship Analysis:
${relationshipAnalysis}

Contribution Analysis:
${contributionAnalysis}

Timeline Summary (key events - will be refined after timeline analysis):
${relevantEmails.length > 0 ? relevantEmails.slice(0, 10).map(e => `- email: ${e.subject} (${e.date ? new Date(e.date).toLocaleDateString() : 'unknown'})`).join('\n') : 'No timeline events yet'}

Synthesize the broader narrative from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective.`
                }], 2000);

                broaderNarrative = broaderNarrative?.trim() || 'Narrative synthesis in progress.';
                console.log(`  ✓ Broader narrative: ${broaderNarrative.length} chars`);
            } else {
                broaderNarrative = 'Insufficient context to build broader narrative.';
            }

            // ===== STEP 7: TIMELINE BUILDING =====
            console.log(`\n  📅 Building intelligent interaction timeline...`);
            
            // Step 1: Collect all potential timeline events
            const allTimelineEvents = [];
            
            if (relevantEmails.length > 0) {
                relevantEmails.forEach(email => {
                    const emailDate = email.date ? new Date(email.date) : null;
                    if (emailDate && !isNaN(emailDate.getTime())) {
                        const participants = [];
                        if (email.from) {
                            const fromMatch = email.from.match(/^([^<]+)(?=\s*<)|^([^@]+@[^>]+)$/);
                            if (fromMatch) {
                                participants.push(fromMatch[1]?.trim().replace(/"/g, '') || fromMatch[2]?.trim() || email.from);
                            }
                        }
                        if (email.to) {
                            const toEmails = email.to.split(',').map(e => {
                                const match = e.match(/^([^<]+)(?=\s*<)|^([^@]+@[^>]+)$/);
                                return match ? (match[1]?.trim().replace(/"/g, '') || match[2]?.trim() || e.trim()) : e.trim();
                            }).filter(Boolean);
                            participants.push(...toEmails);
                        }

                        allTimelineEvents.push({
                            type: 'email',
                            date: emailDate.toISOString(),
                            timestamp: emailDate.getTime(),
                            subject: email.subject || 'No subject',
                            participants: [...new Set(participants)],
                            snippet: (email.body || email.snippet || '').substring(0, 300),
                            fullBody: email.body || email.snippet || '',
                            id: `email-${email.id || emailDate.getTime()}`
                        });
                    }
                });
            }

            if (filesWithContent.length > 0) {
                filesWithContent.forEach(file => {
                    const modifiedDate = file.modifiedTime ? new Date(file.modifiedTime) : null;
                    if (modifiedDate && !isNaN(modifiedDate.getTime())) {
                        allTimelineEvents.push({
                            type: 'document',
                            date: modifiedDate.toISOString(),
                            timestamp: modifiedDate.getTime(),
                            name: file.name || 'Unnamed document',
                            participants: [file.owner || 'Unknown'],
                            action: 'modified',
                            contentPreview: file.content ? file.content.substring(0, 500) : '',
                            id: `doc-${file.id || modifiedDate.getTime()}`
                        });
                    }
                });
            }

            // Add calendar events to timeline with content analysis
            if (calendarEvents && calendarEvents.length > 0) {
                calendarEvents.forEach(event => {
                    const eventStart = event.start?.dateTime || event.start?.date || event.start;
                    if (eventStart) {
                        const eventDate = new Date(eventStart);
                        if (!isNaN(eventDate.getTime())) {
                            const eventAttendees = (event.attendees || []).map(a => a.displayName || a.email || a.emailAddress).filter(Boolean);
                            const eventDescription = event.description || event.notes || '';
                            allTimelineEvents.push({
                                type: 'meeting',
                                date: eventDate.toISOString(),
                                timestamp: eventDate.getTime(),
                                name: event.summary || event.title || 'Past Meeting',
                                participants: eventAttendees,
                                action: 'scheduled',
                                description: eventDescription.substring(0, 500),
                                id: `meeting-${event.id || eventDate.getTime()}`
                            });
                        }
                    }
                });
            }

            // Step 2: Use GPT to intelligently filter and prioritize timeline events
            // Focus on events that help understand WHY this meeting is happening
            let prioritizedTimeline = [];
            
            if (allTimelineEvents.length > 0) {
                console.log(`  🧠 Analyzing ${allTimelineEvents.length} events to identify most relevant timeline...`);
                
                // Sort chronologically first
                allTimelineEvents.sort((a, b) => b.timestamp - a.timestamp);
                
                // Filter to last 6 months
                const sixMonthsAgo = new Date();
                sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
                const recentEvents = allTimelineEvents.filter(e => {
                    if (!e.timestamp) return false;
                    const eventDate = new Date(e.timestamp);
                    return eventDate >= sixMonthsAgo;
                });
                
                // Process in batches if too many events
                const maxEventsToAnalyze = 100;
                const eventsToAnalyze = recentEvents.slice(0, maxEventsToAnalyze);
                
                if (eventsToAnalyze.length > 0) {
                    const userContextPrefix3 = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
                    const timelineAnalysis = await callGPT([{
                        role: 'system',
                        content: `${userContextPrefix3}You are analyzing timeline events to understand WHY the meeting "${meetingTitle}"${meetingDateContext} is happening from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective.

${userContext ? `IMPORTANT: ${userContext.formattedName} is the user you are preparing this brief for. Focus on events that are relevant to ${userContext.formattedName}'s understanding of this meeting.` : ''}

Your goal: Identify the MOST IMPORTANT events that tell the story leading up to this meeting. Focus on events that:
1. **Directly relate to meeting purpose**: Events that discuss or relate to the meeting's topic, agenda, or objectives
2. **Show progression**: Events that show how things evolved leading to this meeting
3. **Reveal context**: Events that provide crucial context for understanding what will be discussed
4. **Highlight blockers/decisions**: Events showing unresolved issues or decisions that need to be made
5. **Demonstrate relationships**: Events showing ${userContext ? `${userContext.formattedName}'s` : 'collaboration'} patterns ${userContext ? 'with others' : 'between attendees'}

EXCLUDE:
- Routine/automated events with no meaningful content
- Completely unrelated events
- Duplicate events (same content, different dates)

Return JSON array of event IDs (from the "id" field) that should be included, ordered by importance (most important first):
{"important_event_ids": ["id1", "id2", ...], "reasoning": "Brief explanation of why these events matter for understanding this meeting from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective"}`,
                    }, {
                        role: 'user',
                        content: `Meeting: "${meetingTitle}"${meetingDateContext}
Meeting Description: ${meeting.description || 'No description provided'}
${userContext ? `User: ${userContext.formattedName} (${userContext.formattedEmail})` : ''}
Other Attendees: ${brief.attendees.map(a => a.name).join(', ')}

Timeline Events (${eventsToAnalyze.length} events):
${eventsToAnalyze.map((e, idx) => {
    const daysAgo = Math.floor((new Date() - new Date(e.timestamp)) / (1000 * 60 * 60 * 24));
    return `[${idx}] ID: ${e.id}
Type: ${e.type}
Date: ${e.date} (${daysAgo} days ago)
${e.type === 'email' ? `Subject: ${e.subject}\nFrom/To: ${e.participants.join(', ')}\nContent: ${e.snippet}` : ''}
${e.type === 'document' ? `Document: ${e.name}\nOwner: ${e.participants.join(', ')}\nPreview: ${e.contentPreview}` : ''}
${e.type === 'meeting' ? `Meeting: ${e.name}\nAttendees: ${e.participants.join(', ')}\nDescription: ${e.description || 'No description'}` : ''}
---`;
}).join('\n\n')}`
                    }], 2000);
                    
                    try {
                        const parsed = safeParseJSON(timelineAnalysis);
                        const importantIds = parsed?.important_event_ids || [];
                        const reasoning = parsed?.reasoning || '';
                        
                        if (reasoning) {
                            console.log(`  💡 Timeline reasoning: ${reasoning.substring(0, 200)}...`);
                        }
                        
                        // Create a map for quick lookup
                        const eventMap = new Map(eventsToAnalyze.map(e => [e.id, e]));
                        
                        // Get prioritized events in order
                        const prioritizedIds = importantIds.filter(id => eventMap.has(id));
                        prioritizedTimeline = prioritizedIds.map(id => eventMap.get(id));
                        
                        // Add any remaining events that weren't prioritized but are still recent
                        const remainingEvents = eventsToAnalyze.filter(e => !importantIds.includes(e.id));
                        prioritizedTimeline.push(...remainingEvents.slice(0, 50)); // Add up to 50 more events
                        
                        console.log(`  ✓ Prioritized ${prioritizedIds.length} most important events, added ${remainingEvents.length} additional recent events`);
                    } catch (e) {
                        console.error(`  ⚠️  Failed to parse timeline analysis, using all recent events: ${e.message}`);
                        prioritizedTimeline = eventsToAnalyze.slice(0, 100);
                    }
                } else {
                    prioritizedTimeline = [];
                }
            }

            // Add meeting date as reference point if available
            if (meetingDate) {
                prioritizedTimeline.push({
                    type: 'meeting',
                    date: meetingDate.iso,
                    timestamp: meetingDate.date.getTime(),
                    name: meetingTitle,
                    participants: brief.attendees.map(a => a.name),
                    action: 'scheduled',
                    isReference: true,
                    id: 'current-meeting'
                });
            }
            
            // Final sort by timestamp (most recent first)
            prioritizedTimeline.sort((a, b) => b.timestamp - a.timestamp);
            
            // Limit to top 100 most relevant events
            const limitedTimeline = prioritizedTimeline.slice(0, 100);
            console.log(`  ✓ Timeline built: ${limitedTimeline.length} events${meetingDate ? ` (meeting scheduled for ${meetingDate.readable})` : ''} (intelligently filtered for meeting relevance)`);

            // ===== STEP 7: RECOMMENDATIONS =====
            console.log(`\n  💡 Generating meeting-specific recommendations...`);
            const userContextPrefix4 = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
            const recommendations = await synthesizeResults(
                `${userContextPrefix4}You are preparing for the meeting: "${meetingTitle}"${meetingDateContext}

${userContext ? `IMPORTANT: ${userContext.formattedName} is the user you are preparing this brief for. Provide recommendations for ${userContext.formattedName}. Use "you" to refer to ${userContext.formattedName}.` : ''}

Based on the LOCAL CONTEXT (emails, documents, attendee info), provide 3-5 strategic recommendations for ${userContext ? userContext.formattedName : 'the user'} for THIS SPECIFIC MEETING on ${meetingDate ? meetingDate.readable : 'the scheduled date'}.

Context available:
- Attendees: ${brief.attendees.map(a => `${a.name} (${a.keyFacts ? a.keyFacts.join('; ') : 'no additional info'})`).join(' | ')}
- Email discussions: ${emailAnalysis}
- Documents: ${documentAnalysis}

Each recommendation should:
1. Reference SPECIFIC information from the context above
2. Be actionable for ${userContext ? userContext.formattedName : 'the user'} in THIS meeting
3. Connect multiple data points
4. Be 25-70 words
5. Use "you" to refer to ${userContext ? userContext.formattedName : 'the user'}

Return ONLY a JSON array. If insufficient context, return fewer but high-quality recommendations.`,
                {
                    meetingTitle: meeting.summary,
                    emailContext: emailAnalysis,
                    docContext: documentAnalysis,
                    attendeeContext: brief.attendees
                },
                900
            );

            let parsedRecommendations = [];
            try {
                const parsed = safeParseJSON(recommendations);
                parsedRecommendations = Array.isArray(parsed) ? parsed.slice(0, 5) : [];
            } catch (e) {
                parsedRecommendations = [];
            }

            // ===== STEP 8: ACTION ITEMS =====
            console.log(`\n  📝 Generating action items...`);
            const userContextPrefix5 = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
            const actionPrompt = `${userContextPrefix5}You are generating PREPARATION action items for the meeting: "${meetingTitle}"${meetingDateContext}

${userContext ? `IMPORTANT: ${userContext.formattedName} is the user you are preparing this brief for. Generate action items for ${userContext.formattedName}. Use "you" to refer to ${userContext.formattedName}.` : ''}

CRITICAL DISTINCTION:
- These are PREP actions to do BEFORE the meeting
- Focus on what ${userContext ? userContext.formattedName : 'the user'} should review, prepare, or think about in advance

FULL CONTEXT:
- Attendees: ${brief.attendees.map(a => `${a.name}${a.keyFacts && a.keyFacts.length > 0 ? ` (${a.keyFacts.slice(0, 2).join('; ')})` : ''}`).join(', ')}
- Email discussions: ${emailAnalysis}
- Document insights: ${documentAnalysis}
- Recommendations: ${parsedRecommendations.join(' | ')}

REQUIREMENTS:
1. Meeting-specific only - directly relevant to "${meetingTitle}"${meetingDate ? ` on ${meetingDate.readable}` : ''}
2. Reference specific context - cite actual documents, emails
3. Actionable prep tasks for ${userContext ? userContext.formattedName : 'the user'} - review, analysis, preparation
4. Detailed and specific - 25-70 words each with concrete details
5. Quality filter - only items that GENUINELY help ${userContext ? userContext.formattedName : 'the user'} prepare
6. Use "you" to refer to ${userContext ? userContext.formattedName : 'the user'}

OUTPUT FORMAT: Return ONLY a JSON array of 3-6 action items.`;

            const actionResult = await synthesizeResults(
                actionPrompt,
                {
                    meetingTitle: meeting.summary,
                    attendees: brief.attendees,
                    emailAnalysis,
                    documentAnalysis,
                    recommendations: parsedRecommendations
                },
                700
            );

            let parsedActionItems = [];
            try {
                const parsed = safeParseJSON(actionResult);
                parsedActionItems = Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'string' && item.length > 15).slice(0, 6) : [];
            } catch (e) {
                parsedActionItems = [];
            }

            // ===== STEP 9: EXECUTIVE SUMMARY (LAST - with full context) =====
            console.log(`\n  📊 Generating executive summary...`);

            // Step 1: Deep analysis of meeting purpose and context (using ALL collated information)
            console.log(`  🔍 Step 1: Deeply analyzing meeting purpose and context...`);
            const userContextPrefix = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
            const meetingPurposeAnalysis = await callGPT([{
                role: 'system',
                content: `${userContextPrefix}You are an expert meeting analyst. Your task is to deeply understand WHY a meeting is happening and WHAT it's truly about from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective.

${userContext ? `IMPORTANT: ${userContext.formattedName} is the user you are preparing this brief for. Analyze the meeting purpose from ${userContext.formattedName}'s perspective. Focus on what ${userContext.formattedName} needs to understand about this meeting.` : ''}

You have access to COMPREHENSIVE collated information:
- Email analysis (discussions, decisions, blockers)
- Document analysis (key insights, proposals, data)
- Relationship analysis (how people work together)
- Contribution analysis (who contributes what and how)
- Broader narrative (the complete story)
- Timeline (key events leading to this meeting)

CRITICAL ANALYSIS QUESTIONS:
1. **What is the meeting's core purpose from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective?** (Not just the title - what problem is it solving for ${userContext ? userContext.formattedName : 'the user'}?)
2. **Why is this meeting happening NOW?** (What triggered it? What timeline pressure exists?)
3. **What questions need to be answered?** (What decisions need to be made? What information is needed?)
4. **What is the narrative leading to this meeting?** (What events, discussions, or decisions led here?)
5. **What are the stakes for ${userContext ? userContext.formattedName : 'the user'}?** (What happens if this meeting goes well/poorly?)
6. **Who are the key players and what are their roles relative to ${userContext ? userContext.formattedName : 'the user'}?** (Who drives? Who decides? Who contributes?)

Return a detailed JSON analysis:
{
  "corePurpose": "What is this meeting really about for ${userContext ? userContext.formattedName : 'the user'}? (2-3 sentences)",
  "whyNow": "Why is this happening at this specific time? (1-2 sentences)",
  "keyQuestions": ["Question 1", "Question 2", "Question 3"],
  "narrative": "The story leading to this meeting - what happened that made this meeting necessary? (3-5 sentences)",
  "stakes": "What are the consequences/importance for ${userContext ? userContext.formattedName : 'the user'}? (1-2 sentences)",
  "keyPlayers": ["Who are the key contributors and what are their roles relative to ${userContext ? userContext.formattedName : 'the user'}?"],
  "criticalContext": ["Most important context point 1", "Most important context point 2", ...]
}`
            }, {
                role: 'user',
                content: `Meeting: "${meetingTitle}"${meetingDateContext}
Meeting Description: ${meeting.description || 'No description provided'}

${userContext ? `User: ${userContext.formattedName} (${userContext.formattedEmail})` : ''}
Other Attendees:
${brief.attendees.map(a => `- ${a.name} (${a.company})${a.keyFacts && a.keyFacts.length > 0 ? `: ${a.keyFacts.slice(0, 2).join('; ')}` : ''}`).join('\n')}

COMPREHENSIVE COLLATED INFORMATION:

Email Analysis:
${emailAnalysis ? (emailAnalysis.length > 2500 ? emailAnalysis.substring(0, 2500) + '\n[...truncated...]' : emailAnalysis) : 'No email context'}

Document Analysis:
${documentAnalysis ? (documentAnalysis.length > 2000 ? documentAnalysis.substring(0, 2000) + '\n[...truncated...]' : documentAnalysis) : 'No document analysis'}

Relationship Analysis:
${relationshipAnalysis ? (relationshipAnalysis.length > 2000 ? relationshipAnalysis.substring(0, 2000) + '\n[...truncated...]' : relationshipAnalysis) : 'No relationship analysis'}

Contribution Analysis:
${contributionAnalysis ? (contributionAnalysis.length > 1500 ? contributionAnalysis.substring(0, 1500) + '\n[...truncated...]' : contributionAnalysis) : 'No contribution analysis'}

Broader Narrative:
${broaderNarrative ? (broaderNarrative.length > 2000 ? broaderNarrative.substring(0, 2000) + '\n[...truncated...]' : broaderNarrative) : 'No broader narrative'}

Key Timeline Events (from broader narrative analysis):
${limitedTimeline && limitedTimeline.length > 0 ? limitedTimeline.slice(0, 15).map(e => `- ${e.type}: ${e.name || e.subject} (${e.date ? new Date(e.date).toLocaleDateString() : 'unknown date'})`).join('\n') : 'Timeline events will be analyzed'}

Analyze deeply: What is this meeting REALLY about? Use ALL the collated information to understand the complete picture.`
            }], 2500);

            let purposeData = {};
            try {
                const parsed = safeParseJSON(meetingPurposeAnalysis);
                if (parsed && typeof parsed === 'object') {
                    purposeData = parsed;
                    console.log(`  ✓ Meeting purpose analyzed: ${purposeData.corePurpose ? purposeData.corePurpose.substring(0, 100) + '...' : 'analysis complete'}`);
                } else {
                    console.warn(`  ⚠️  Could not parse meeting purpose analysis, using raw text`);
                    purposeData.corePurpose = meetingPurposeAnalysis;
                }
            } catch (e) {
                console.error(`  ⚠️  Failed to parse meeting purpose analysis: ${e.message}`);
                purposeData.corePurpose = meetingPurposeAnalysis || 'Meeting purpose analysis unavailable';
            }

            // Step 2: Generate executive summary based on deep analysis
            console.log(`  ✍️  Step 2: Generating executive summary from analysis...`);
            const userContextPrefix2 = userContext ? `You are preparing a brief for ${userContext.formattedName} (${userContext.formattedEmail}). ` : '';
            brief.summary = await synthesizeResults(
                `${userContextPrefix2}You are creating an executive summary for the meeting: "${meetingTitle}"${meetingDateContext}

${userContext ? `IMPORTANT: ${userContext.formattedName} is the user you are preparing this brief for. Structure the summary from ${userContext.formattedName}'s perspective. Use "you" to refer to ${userContext.formattedName}.` : ''}

DEEP ANALYSIS OF MEETING PURPOSE:
${JSON.stringify(purposeData, null, 2)}

COMPREHENSIVE COLLATED CONTEXT:

Email Analysis:
${emailAnalysis ? (emailAnalysis.length > 2000 ? emailAnalysis.substring(0, 2000) + '\n[...truncated...]' : emailAnalysis) : 'No email context'}

Document Analysis:
${documentAnalysis ? (documentAnalysis.length > 1500 ? documentAnalysis.substring(0, 1500) + '\n[...truncated...]' : documentAnalysis) : 'No document analysis'}

Relationship Analysis:
${relationshipAnalysis ? (relationshipAnalysis.length > 1500 ? relationshipAnalysis.substring(0, 1500) + '\n[...truncated...]' : relationshipAnalysis) : 'No relationship analysis'}

Contribution Analysis:
${contributionAnalysis ? (contributionAnalysis.length > 1200 ? contributionAnalysis.substring(0, 1200) + '\n[...truncated...]' : contributionAnalysis) : 'No contribution analysis'}

Broader Narrative:
${broaderNarrative ? (broaderNarrative.length > 1500 ? broaderNarrative.substring(0, 1500) + '\n[...truncated...]' : broaderNarrative) : 'No broader narrative'}

CRITICAL REQUIREMENTS:
1. **Answer WHY this meeting exists for ${userContext ? userContext.formattedName : 'the user'}**: Use the "narrative" and "whyNow" from the analysis above
2. **Be SPECIFIC**: Reference actual people, documents, dates, decisions from the context
3. **Tell the STORY**: Explain the journey that led to this meeting (use the "narrative" field)
4. **Highlight STAKES**: What matters here for ${userContext ? userContext.formattedName : 'the user'}? (use the "stakes" field)
5. **Reference KEY QUESTIONS**: What needs to be answered? (use "keyQuestions")
6. **TEMPORAL ACCURACY**: This meeting is on ${meetingDate ? meetingDate.readable : 'the scheduled date'}. Ground everything in the correct timeframe.
7. **USER PERSPECTIVE**: Write from ${userContext ? userContext.formattedName + "'s" : "the user's"} perspective. Use "you" to refer to ${userContext ? userContext.formattedName : 'the user'}.

STRUCTURE (4-5 sentences):
- Sentence 1: ${userContext ? `You are meeting with` : 'WHO is meeting'} and WHAT is the core purpose (use "corePurpose" from analysis)
- Sentence 2: THE NARRATIVE - What happened that led to this meeting? (use "narrative" field)
- Sentence 3: KEY CONTEXT - What specific information from emails/docs frames this discussion?
- Sentence 4: CURRENT STATE - What questions need answers? What blockers exist? (use "keyQuestions")
- Sentence 5: WHY IT MATTERS - What are the stakes for ${userContext ? userContext.formattedName : 'you'}? Why now? (use "stakes" and "whyNow")

Write as if briefing ${userContext ? userContext.formattedName : 'an executive'} who needs to understand not just WHAT the meeting is about, but WHY it's happening and WHAT needs to happen. Make it compelling and specific. Use "you" consistently to refer to ${userContext ? userContext.formattedName : 'the user'}.`,
                {
                    meeting: {
                        title: meetingTitle,
                        description: meeting.description || '',
                        purposeAnalysis: purposeData
                    },
                    attendees: brief.attendees.map(a => ({
                        name: a.name,
                        title: a.title,
                        company: a.company,
                        keyFacts: a.keyFacts?.slice(0, 3) || []
                    })),
                    emailAnalysis: emailAnalysis || 'No email context',
                    documentAnalysis: documentAnalysis || 'No document analysis',
                    relationshipAnalysis: relationshipAnalysis || 'No relationship analysis',
                    timeline: limitedTimeline.slice(0, 15).map(e => ({ 
                        type: e.type, 
                        date: e.date, 
                        name: e.name || e.subject,
                        snippet: e.snippet || e.description || ''
                    })),
                    recommendations: parsedRecommendations.slice(0, 3)
                },
                1000 // Increased tokens for better summary
            );

            console.log(`  ✓ Executive summary: ${brief.summary?.length || 0} chars`);

            // ===== ASSEMBLE FINAL BRIEF =====
            brief.emailAnalysis = emailAnalysis;
            brief.documentAnalysis = documentAnalysis;
            brief.companyResearch = companyResearch;
            brief.relationshipAnalysis = relationshipAnalysis;
            brief.contributionAnalysis = contributionAnalysis;
            brief.broaderNarrative = broaderNarrative;
            brief.timeline = limitedTimeline;
            brief.recommendations = parsedRecommendations;
            brief.actionItems = parsedActionItems;

            // Add stats
            brief.stats = {
                emailCount: emails.length,
                relevantEmailCount: relevantEmails.length,
                fileCount: files.length,
                filesWithContentCount: filesWithContent.length,
                calendarEventCount: calendarEvents.length,
                attendeeCount: brief.attendees.length,
                multiAccount: !!req.userId,
                accountCount: accounts.length,
                multiAccountStats: brief._multiAccountStats
            };

            console.log(`\n✅ Original inline analysis complete! ${brief.attendees.length} attendees, ${relevantEmails.length} relevant emails, ${filesWithContent.length} analyzed docs, ${limitedTimeline.length} timeline events`);

            // Return comprehensive brief
            res.json(brief);

        } catch (analysisError) {
            console.error('❌ AI analysis failed:', analysisError);
            console.error('Stack trace:', analysisError.stack);

            // FALLBACK: Return raw context if analysis fails
            res.json({
                success: true,
                context: {
                    emails,
                    files,
                    calendarEvents,
                    meeting,
                    attendees
                },
                stats: {
                    emailCount: emails.length,
                    fileCount: files.length,
                    calendarEventCount: calendarEvents.length,
                    attendeeCount: attendees.length,
                    multiAccount: !!req.userId,
                    accountCount: accounts.length,
                    multiAccountStats: brief._multiAccountStats
                },
                error: 'AI analysis failed, showing raw data',
                analysisError: analysisError.message
            });
        }

    } catch (error) {
        logger.error({
            requestId,
            error: error.message,
            stack: error.stack,
            meetingTitle: req.body?.meeting?.summary || req.body?.meeting?.title,
            userId: req.userId || 'anonymous'
        }, 'Error preparing meeting brief');
        
        console.error('Meeting prep error:', error);
        
        res.status(error.status || 500).json({
            error: 'Meeting preparation failed',
            message: error.message || 'An unexpected error occurred',
            requestId: requestId,
            ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
        });
    }
});

module.exports = router;
