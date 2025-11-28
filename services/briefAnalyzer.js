/**
 * Meeting Brief Analyzer Service
 *
 * Transforms raw context data (emails, files, calendar events) into
 * AI-analyzed meeting intelligence using GPT-4o.
 *
 * Features:
 * - Parallel processing of independent analyses
 * - Error handling with graceful fallbacks
 * - Token optimization (summarization for large contexts)
 * - Cost tracking and logging
 */

const fetch = require('node-fetch');

class BriefAnalyzer {
    constructor(openaiApiKey, parallelClient = null) {
        this.openaiApiKey = openaiApiKey;
        this.parallelClient = parallelClient;
        this.costTracker = { totalTokens: 0, estimatedCost: 0 };
    }

    /**
     * Main entry point: Analyze all context and return complete brief
     */
    async analyze(context, options = {}) {
        const {
            meeting,
            attendees,
            emails,
            files,
            calendarEvents
        } = context;

        const {
            includeWebResearch = false,
            maxTokensPerCall = 8000 // Reduced from 16000 to 8000 for faster processing
        } = options;

        console.log(`\n🧠 Starting AI analysis of meeting brief...`);
        console.log(`   Emails: ${emails?.length || 0}, Files: ${files?.length || 0}, Calendar: ${calendarEvents?.length || 0}`);

        try {
            // PARALLELIZATION: All independent analyses run simultaneously
            // These 5 analyses don't depend on each other, so they execute in parallel
            const [
                attendeesAnalysis,
                emailAnalysis,
                documentAnalysis,
                relationshipAnalysis,
                timeline
            ] = await Promise.all([
                this.analyzeAttendees(attendees, emails, files, includeWebResearch), // Processes all attendees in parallel internally
                this.analyzeEmails(emails), // Independent GPT call
                this.analyzeDocuments(files), // Independent GPT call
                this.analyzeRelationships(attendees, emails, calendarEvents), // Independent GPT call
                this.buildTimeline(emails, files, calendarEvents) // Synchronous operation
            ]);

            // PARALLELIZATION: All dependent analyses run simultaneously after independent ones complete
            // These 4 analyses depend on the results above but are independent of each other
            const [summary, recommendations, actionItems, companyResearch] = await Promise.all([
                this.generateSummary(meeting, {
                    attendeesAnalysis,
                    emailAnalysis,
                    documentAnalysis,
                    relationshipAnalysis
                }),
                this.generateRecommendations(meeting, {
                    attendeesAnalysis,
                    emailAnalysis,
                    documentAnalysis,
                    relationshipAnalysis
                }),
                this.generateActionItems(meeting, {
                    attendeesAnalysis,
                    emailAnalysis,
                    documentAnalysis
                }),
                this.researchCompaniesWithParallel(attendeesAnalysis, meeting)
            ]);

            // Compile final brief
            const brief = {
                success: true,
                summary,
                attendees: attendeesAnalysis,
                relationshipAnalysis,
                timeline,
                emailAnalysis,
                documentAnalysis,
                companyResearch,
                recommendations,
                actionItems,

                // Include raw context for reference
                context: {
                    emails,
                    files,
                    calendarEvents,
                    meeting,
                    attendees
                },

                // Metadata
                _analysisMetadata: {
                    generatedAt: new Date().toISOString(),
                    tokensUsed: this.costTracker.totalTokens,
                    estimatedCost: this.costTracker.estimatedCost,
                    webResearchIncluded: includeWebResearch
                }
            };

            console.log(`✅ AI analysis complete!`);
            console.log(`   Tokens used: ${this.costTracker.totalTokens}`);
            console.log(`   Estimated cost: $${this.costTracker.estimatedCost.toFixed(4)}`);

            return brief;

        } catch (error) {
            console.error('❌ Error during AI analysis:', error);
            throw new Error(`Brief analysis failed: ${error.message}`);
        }
    }

    /**
     * Analyze attendees and extract key facts (ORIGINAL WITH WEB RESEARCH)
     */
    async analyzeAttendees(attendees, emails, files, includeWebResearch) {
        if (!attendees || attendees.length === 0) {
            return [];
        }

        console.log(`   📊 Analyzing ${attendees.length} attendees...`);

        // PARALLELIZATION: Process all attendees simultaneously
        // Each attendee's web research, GPT calls, and synthesis happen in parallel across attendees
        const attendeePromises = attendees.map(async (attendee) => {
            try {
                const name = attendee.displayName || attendee.name || attendee.email;
                const email = attendee.email;
                const company = this.extractCompany(attendee);

                console.log(`   🔍 Researching ${name}...`);

                // Build context for this attendee from emails and files
                const attendeeContext = this.buildAttendeeContext(
                    attendee,
                    emails || [],
                    files || []
                );

                let keyFacts = [];
                let title = '';

                // ORIGINAL: Always do web research for attendees if Parallel API available
                if (includeWebResearch && this.parallelClient) {
                    try {
                        // Craft 3 search queries for this attendee
                        const searchQueries = await this.craftSearchQueries(
                            `Research attendee: ${name} (${email}, ${company})

Generate 3 highly specific web search queries to find:
1. Professional background (LinkedIn, company website, professional profiles)
2. Recent activities, announcements, or publications
3. Role, title, and expertise areas

Focus on verifiable, recent information that would be useful for meeting preparation.`
                        );

                        if (searchQueries.length > 0) {
                            // PARALLELIZATION: Execute all 3 search queries simultaneously for this attendee
                            const searchResults = [];
                            const searchPromises = searchQueries.map(async (query) => {
                                try {
                                    const result = await this.parallelClient.beta.search({
                                        objective: query,
                                        search_queries: [query],
                                        mode: 'one-shot',
                                        max_results: 8, // Restored from 5 to 8 for higher quality
                                        max_chars_per_result: 3000 // Restored from 2000 to 3000 for higher quality
                                    });

                                    if (result && result.results) {
                                        searchResults.push(...result.results);
                                    }
                                    console.log(`   ✅ Search completed: ${query.substring(0, 50)}...`);
                                } catch (e) {
                                    console.error(`   ⚠️  Search failed: ${query.substring(0, 50)}...`, e.message);
                                }
                            });

                            await Promise.allSettled(searchPromises);

                            // Extract title from web results using regex
                            if (searchResults.length > 0) {
                                title = this.extractTitleFromWebResults(searchResults, name);
                            }

                            // Synthesize key facts from web results + email/file context
                            if (searchResults.length > 0) {
                                const combinedContext = `
Web Research Results:
${JSON.stringify(searchResults).substring(0, 15000)} // Restored from 10000 to 15000 chars for higher quality

Email Context:
${attendeeContext.emailContext}

Document Context:
${attendeeContext.documentContext}
`;

                                    const synthesized = await this.synthesizeResults(
                                    `Extract 3-5 key facts about ${name} that would be valuable for meeting preparation.
Focus on:
- Current role and title
- Professional background and expertise
- Recent activities or achievements
- Relevant projects or initiatives

Return information that would be genuinely useful in a business meeting context.`,
                                    combinedContext,
                                    600 // Restored from 400 to 600 tokens for higher quality
                                );

                                // Convert synthesized paragraph into bullet points
                                if (synthesized) {
                                    // Split into sentences and clean up
                                    keyFacts = synthesized
                                        .split(/[.!?]+/)
                                        .map(s => s.trim())
                                        .filter(s => s.length > 15 && s.length < 200)
                                        .slice(0, 5);
                                }
                            }
                        }

                    } catch (webError) {
                        console.error(`   ⚠️  Web research failed for ${name}:`, webError.message);
                    }
                }

                // Fallback: If no web research or web research failed, use email/file context only
                if (keyFacts.length === 0) {
                    try {
                        const contextFacts = await this.callGPT({
                            systemPrompt: `You are an expert meeting preparation analyst. Extract 3-5 key facts about this attendee from the provided context. Return ONLY a JSON array of strings, nothing else.`,
                            userPrompt: `Attendee: ${name}
Email: ${email}
Organization: ${company}

Email Context:
${attendeeContext.emailContext}

Document Context:
${attendeeContext.documentContext}

Extract 3-5 key facts as a JSON array of strings.`,
                            maxTokens: 500, // Restored from 300 to 500 tokens for higher quality
                            temperature: 0.7,
                            responseFormat: 'json_array'
                        });

                        keyFacts = contextFacts;
                    } catch (e) {
                        console.error(`   ⚠️  Context analysis failed for ${name}:`, e.message);
                        keyFacts = [];
                    }
                }

                console.log(`   ✅ ${name}: ${keyFacts.length} facts, title: "${title || 'N/A'}"`);

                return {
                    name,
                    email,
                    title: title || '',
                    company,
                    keyFacts: keyFacts || [],
                    organizer: attendee.organizer || false
                };

            } catch (error) {
                console.error(`   ⚠️  Error analyzing attendee ${attendee.email}:`, error.message);
                return {
                    name: attendee.displayName || attendee.name || attendee.email,
                    email: attendee.email,
                    title: '',
                    company: this.extractCompany(attendee),
                    keyFacts: [],
                    organizer: attendee.organizer || false
                };
            }
        });

        const analyzedAttendees = await Promise.all(attendeePromises);
        console.log(`   ✅ Attendee analysis complete`);
        return analyzedAttendees;
    }

    /**
     * Analyze email threads (ORIGINAL SOPHISTICATED PROMPT)
     */
    async analyzeEmails(emails) {
        if (!emails || emails.length === 0) {
            return 'No recent email activity to analyze.';
        }

        console.log(`   📧 Analyzing ${emails.length} emails...`);

        try {
            // Sort by date and take most recent 10 emails
            const recentEmails = emails
                .sort((a, b) => new Date(b.date) - new Date(a.date))
                .slice(0, 10); // Reduced from 20 to 10 for faster processing

            // Summarize email content (prevent token overflow)
            const emailSummaries = recentEmails.map((email, idx) => {
                const body = email.body || email.snippet || '';
                const truncatedBody = body.substring(0, 500); // Reduced from 1000 to 500 chars
                return `Email ${idx + 1}:
Subject: ${email.subject}
From: ${email.from}
To: ${email.to}
Date: ${email.date}
Content: ${truncatedBody}
---`;
            }).join('\n\n');

            // ORIGINAL PROMPT: Focus on actionable intelligence
            const analysis = await this.synthesizeResults(
                `Analyze these email threads and extract key themes, decisions, and action items discussed.
Return a 2-3 sentence paragraph summarizing:
- Main topics discussed
- Important decisions or agreements
- Outstanding questions or action items`,
                emailSummaries,
                300 // Reduced from 500 to 300 tokens
            );

            console.log(`   ✅ Email analysis complete`);
            return analysis || 'Unable to extract meaningful insights from email threads.';

        } catch (error) {
            console.error(`   ⚠️  Error analyzing emails:`, error.message);
            return `Unable to analyze emails due to processing error.`;
        }
    }

    /**
     * Analyze documents (ORIGINAL SOPHISTICATED PROMPT)
     */
    async analyzeDocuments(files) {
        if (!files || files.length === 0) {
            return 'No relevant documents identified.';
        }

        console.log(`   📄 Analyzing ${files.length} documents...`);

        try {
            // Filter files with content and prioritize recent ones
            // Check both hasContent flag OR content property (for backward compatibility)
            const filesWithContent = files
                .filter(f => (f.hasContent || f.content) && f.content)
                .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime))
                .slice(0, 3); // Reduced from 5 to 3 for faster processing

            if (filesWithContent.length === 0) {
                // For files without content, infer relevance from metadata
                const fileMetadata = files.slice(0, 10).map(f =>
                    `${f.name} (${f.mimeType}, modified: ${f.modifiedTime})`
                ).join('\n');

                const analysis = await this.synthesizeResults(
                    `Based on these document titles and metadata, infer what materials are relevant for this meeting.
Return a 2-3 sentence paragraph describing:
- What these documents likely contain
- How they relate to the meeting topic
- What to review or prepare from them`,
                    fileMetadata,
                    300
                );

                return analysis || 'Documents found but no readable content available.';
            }

            // For files WITH content, do deep analysis
            const docSummaries = filesWithContent.map((file, idx) => {
                const content = file.content.substring(0, 8000); // Reduced from 15000 to 8000 chars
                return `Document ${idx + 1}:
Name: ${file.name}
Type: ${file.mimeType}
Owner: ${file.owner}
Last Modified: ${file.modifiedTime}
Content:
${content}
---`;
            }).join('\n\n');

            const analysis = await this.synthesizeResults(
                `Analyze these documents deeply and extract:
- Key insights and main points
- Decisions made or proposed
- Action items and next steps

Return a 2-3 sentence paragraph.`,
                docSummaries,
                400 // Reduced from 600 to 400 tokens
            );

            console.log(`   ✅ Document analysis complete`);
            return analysis || 'Unable to extract insights from documents.';

        } catch (error) {
            console.error(`   ⚠️  Error analyzing documents:`, error.message);
            return `Unable to analyze documents due to processing error.`;
        }
    }

    /**
     * Analyze relationships and dynamics
     */
    async analyzeRelationships(attendees, emails, calendarEvents) {
        if (!attendees || attendees.length === 0) {
            return 'No attendee information available for relationship analysis.';
        }

        console.log(`   🤝 Analyzing relationships...`);

        try {
            // Build relationship context
            const attendeeList = attendees.map(att =>
                `${att.displayName || att.name || att.email} (${att.email})${att.organizer ? ' [ORGANIZER]' : ''}`
            ).join('\n');

            // Count interactions per attendee
            const interactionCounts = this.countInteractions(attendees, emails || [], calendarEvents || []);

            // Recent email patterns
            const recentEmailPatterns = this.analyzeEmailPatterns(attendees, emails || []);

            const analysis = await this.callGPT({
                systemPrompt: `You are an expert in professional relationship dynamics. Analyze attendee relationships and provide insights on:
1. Working relationship patterns and history
2. Power dynamics and decision-making influence
3. Communication styles and preferences

Be tactful and professional.`,
                userPrompt: `Attendees:
${attendeeList}

Interaction Summary:
${interactionCounts}

Recent Email Patterns:
${recentEmailPatterns}

Email History: ${emails?.length || 0} emails
Calendar History: ${calendarEvents?.length || 0} past meetings

Analyze the relationship dynamics.`,
                maxTokens: 1000, // Reduced from 2000 to 1000 tokens
                temperature: 0.7            });

            console.log(`   ✅ Relationship analysis complete`);
            return analysis;

        } catch (error) {
            console.error(`   ⚠️  Error analyzing relationships:`, error.message);
            return `Unable to analyze relationships due to processing error.`;
        }
    }

    /**
     * Build chronological timeline
     */
    buildTimeline(emails, files, calendarEvents) {
        console.log(`   📅 Building timeline...`);

        const timeline = [];

        // Add emails to timeline
        if (emails) {
            emails.forEach(email => {
                timeline.push({
                    type: 'email',
                    date: new Date(email.date).toISOString(),
                    subject: email.subject,
                    participants: [email.from, email.to].filter(Boolean),
                    snippet: (email.body || email.snippet || '').substring(0, 200)
                });
            });
        }

        // Add documents to timeline
        if (files) {
            files.forEach(file => {
                timeline.push({
                    type: 'document',
                    date: file.modifiedTime || file.createdTime,
                    name: file.name,
                    action: file.modifiedTime ? 'modified' : 'created',
                    participants: [file.owner].filter(Boolean)
                });
            });
        }

        // Add calendar events to timeline
        if (calendarEvents) {
            calendarEvents.forEach(event => {
                timeline.push({
                    type: 'meeting',
                    date: event.start?.dateTime || event.start?.date,
                    subject: event.summary,
                    participants: event.attendees?.map(a => a.email) || []
                });
            });
        }

        // Sort by date (most recent first)
        timeline.sort((a, b) => new Date(b.date) - new Date(a.date));

        // Limit to 50 most recent events
        const limitedTimeline = timeline.slice(0, 50);

        console.log(`   ✅ Timeline built: ${limitedTimeline.length} events`);
        return limitedTimeline;
    }

    /**
     * Generate executive summary
     */
    async generateSummary(meeting, analyses) {
        console.log(`   📝 Generating executive summary...`);

        try {
            const summary = await this.callGPT({
                systemPrompt: `You are an executive assistant creating a brief, powerful meeting summary. Write 2-3 sentences that capture the essence of this meeting and what the user needs to know. Focus on what's actionable and decision-critical.`,
                userPrompt: `Meeting: ${meeting?.summary || 'Upcoming Meeting'}
Time: ${meeting?.start?.dateTime || meeting?.start?.date || 'Not specified'}
Attendees: ${analyses.attendeesAnalysis?.map(a => a.name).join(', ') || 'Not specified'}

Context Analysis:
- Email Analysis: ${(analyses.emailAnalysis || '').substring(0, 300)} // Reduced from 500
- Document Analysis: ${(analyses.documentAnalysis || '').substring(0, 300)} // Reduced from 500
- Relationship Analysis: ${(analyses.relationshipAnalysis || '').substring(0, 300)} // Reduced from 500

Generate a powerful 2-3 sentence executive summary.`,
                maxTokens: 200, // Reduced from 300 to 200 tokens
                temperature: 0.7
            });

            console.log(`   ✅ Summary generated`);
            return summary;

        } catch (error) {
            console.error(`   ⚠️  Error generating summary:`, error.message);
            return `Meeting with ${analyses.attendeesAnalysis?.length || 0} attendees.`;
        }
    }

    /**
     * Generate strategic recommendations (ORIGINAL PROMPT)
     */
    async generateRecommendations(meeting, analyses) {
        console.log(`   💡 Generating recommendations...`);

        try {
            const recommendationsResult = await this.synthesizeResults(
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
                    meeting: { title: meeting?.summary, description: meeting?.description },
                    attendees: analyses.attendeesAnalysis || [],
                    emailAnalysis: analyses.emailAnalysis,
                    documentAnalysis: analyses.documentAnalysis,
                    relationshipAnalysis: analyses.relationshipAnalysis
                },
                500 // Reduced from 800 to 500 tokens
            );

            // Parse with fallback logic (ORIGINAL)
            let parsedRecommendations = [];
            try {
                let cleanRecs = recommendationsResult
                    .replace(/```json/g, '')
                    .replace(/```/g, '')
                    .trim();
                const parsed = JSON.parse(cleanRecs);
                parsedRecommendations = Array.isArray(parsed) ? parsed.slice(0, 5) : [];
            } catch (e) {
                console.warn(`   ⚠️  Failed to parse recommendations JSON, using fallback:`, e.message);
                // Fallback: split by newlines/bullets
                parsedRecommendations = recommendationsResult ?
                    recommendationsResult.split(/[\n•\-]/)
                        .map(r => r.trim().replace(/^[\d\.\)]+\s*/, ''))
                        .filter(r => r && r.length > 20)
                        .slice(0, 5) : [];
            }

            console.log(`   ✅ Recommendations generated: ${parsedRecommendations.length}`);
            return parsedRecommendations;

        } catch (error) {
            console.error(`   ⚠️  Error generating recommendations:`, error.message);
            return ['Review meeting agenda', 'Prepare questions for attendees'];
        }
    }

    /**
     * Generate action items (ORIGINAL PROMPT)
     */
    async generateActionItems(meeting, analyses) {
        console.log(`   ✅ Generating action items...`);

        try {
            const attendeesSummary = analyses.attendeesAnalysis?.map(a => `${a.name} (${a.title})`).join(', ') || 'N/A';

            const actionResult = await this.synthesizeResults(
                `Based on this meeting information, suggest 3-5 specific action items to prepare effectively.

Meeting: ${meeting?.summary || 'Upcoming Meeting'}
Attendees: ${attendeesSummary}

Return ONLY a JSON array of actionable preparation steps. Each item should be:
- Specific and concrete (what to review, prepare, or research)
- Actionable before the meeting
- Relevant to the attendees and context
- 10-40 words

Example format:
["Review Q3 sales metrics and prepare comparison with Q2 targets", "Research competitor pricing models mentioned in John's last email", "Prepare technical architecture diagram for the new API integration"]

Return ONLY the JSON array, no other text.`,
                {
                    meeting: meeting,
                    attendees: analyses.attendeesAnalysis || [],
                    emailAnalysis: analyses.emailAnalysis,
                    documentAnalysis: analyses.documentAnalysis
                },
                400
            );

            // Parse with fallback logic (ORIGINAL)
            let parsedActionItems = [];
            try {
                let cleanAction = actionResult
                    .replace(/```json/g, '')
                    .replace(/```/g, '')
                    .trim();
                const parsed = JSON.parse(cleanAction);
                parsedActionItems = Array.isArray(parsed) ? parsed
                    .filter(item => item && typeof item === 'string' && item.length > 10)
                    .slice(0, 5) : [];
            } catch (e) {
                console.warn(`   ⚠️  Failed to parse action items JSON, using fallback:`, e.message);
                // Fallback parsing
                parsedActionItems = actionResult ?
                    actionResult
                        .split(/[\n•\-]/)
                        .map(a => a.trim().replace(/^[\d\.\)]+\s*/, ''))
                        .filter(a => a && a.length > 10)
                        .slice(0, 5) : [];
            }

            console.log(`   ✅ Action items generated: ${parsedActionItems.length}`);
            return parsedActionItems;

        } catch (error) {
            console.error(`   ⚠️  Error generating action items:`, error.message);
            return ['Review meeting agenda', 'Confirm attendance'];
        }
    }

    /**
     * Helper: Call GPT API
     */
    async callGPT({ systemPrompt, userPrompt, maxTokens = 2000, temperature = 0.7, responseFormat = 'text' }) {
        try {
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ];

            const requestBody = {
                model: 'gpt-5',
                messages,
                temperature,
                max_tokens: maxTokens
            };

            // Add response format if JSON requested
            if (responseFormat === 'json_array') {
                requestBody.response_format = { type: 'json_object' };
                messages[0].content += '\n\nYou MUST respond with valid JSON only. Format: {"items": ["item1", "item2", ...]}';
            }

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openaiApiKey}`
                },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`GPT API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            const content = data.choices[0].message.content;

            // Track costs
            this.costTracker.totalTokens += data.usage?.total_tokens || 0;
            this.costTracker.estimatedCost += this.calculateCost(data.usage);

            // Parse JSON if requested
            if (responseFormat === 'json_array') {
                try {
                    const parsed = JSON.parse(content);
                    return Array.isArray(parsed) ? parsed : (parsed.items || parsed.array || parsed.recommendations || parsed.actionItems || parsed.keyFacts || []);
                } catch (e) {
                    console.warn('Failed to parse JSON response, returning raw content');
                    return [content];
                }
            }

            return content;

        } catch (error) {
            console.error('GPT API call failed:', error);
            throw error;
        }
    }

    /**
     * Helper: Calculate API cost
     */
    calculateCost(usage) {
        if (!usage) return 0;
        // GPT-4o pricing: $2.50 per 1M input tokens, $10 per 1M output tokens
        const inputCost = (usage.prompt_tokens / 1000000) * 2.50;
        const outputCost = (usage.completion_tokens / 1000000) * 10.00;
        return inputCost + outputCost;
    }

    /**
     * Helper: Build attendee context from emails and files
     */
    buildAttendeeContext(attendee, emails, files) {
        const attendeeEmail = attendee.email.toLowerCase();

        // Find emails involving this attendee - RESTORED HIGH QUALITY: 20 emails with full content
        const relevantEmails = emails
            .filter(email =>
                email.from?.toLowerCase().includes(attendeeEmail) ||
                email.to?.toLowerCase().includes(attendeeEmail)
            )
            .sort((a, b) => new Date(b.date) - new Date(a.date)) // Sort by date, most recent first
            .slice(0, 20); // Restored from 5 to 20 emails

        const emailContext = relevantEmails.length > 0
            ? relevantEmails.map((e, idx) => {
                const body = (e.body || e.snippet || '').substring(0, 1000); // Restored from metadata-only to 1000 chars
                return `Email ${idx + 1}:
Subject: ${e.subject}
From: ${e.from}
To: ${e.to}
Date: ${e.date}
Content: ${body}
---`;
            }).join('\n\n')
            : 'No recent email interactions';

        // Find files owned or modified by this attendee - RESTORED HIGH QUALITY: 5 files with content
        const relevantFiles = files
            .filter(file => 
                (file.owner?.toLowerCase().includes(attendeeEmail)) ||
                (file.content && file.content.toLowerCase().includes(attendeeEmail))
            )
            .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime)) // Sort by date, most recent first
            .slice(0, 5); // Restored from 3 to 5 files

        const documentContext = relevantFiles.length > 0
            ? relevantFiles.map((f, idx) => {
                const content = (f.content || '').substring(0, 15000); // Restored from metadata-only to 15000 chars
                return `Document ${idx + 1}:
Name: ${f.name}
Type: ${f.mimeType}
Owner: ${f.owner}
Last Modified: ${f.modifiedTime}
Content:
${content}
---`;
            }).join('\n\n')
            : 'No recent document activity';

        return { emailContext, documentContext };
    }

    /**
     * Helper: Extract title from attendee data
     */
    extractTitle(attendee, emails) {
        // Try to extract from email signatures or metadata
        // For now, return empty - can be enhanced later
        return '';
    }

    /**
     * Helper: Extract company from email domain
     */
    extractCompany(attendee) {
        try {
            const domain = attendee.email.split('@')[1];
            if (!domain) return '';

            // Remove common TLDs and format
            const company = domain
                .split('.')[0]
                .replace(/[_-]/g, ' ')
                .split(' ')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join(' ');

            return company;
        } catch (e) {
            return '';
        }
    }

    /**
     * Helper: Extract title from web search results (ORIGINAL)
     * Uses regex patterns to find job titles in search results
     */
    extractTitleFromWebResults(searchResults, name) {
        try {
            // Common title patterns
            const titlePatterns = [
                /(?:is|as|currently|serves as|works as|role as|position as|title is)\s+(?:a|an|the)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s+of)?)/i,
                /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+at\s+/i,
                /(?:^|\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4})\s*\|/,
                /(?:^|\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4})\s*\-/,
                new RegExp(`${name}\\s*[\\|\\-]\\s*([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,4})`, 'i')
            ];

            // Common job title keywords
            const titleKeywords = [
                'CEO', 'CTO', 'CFO', 'COO', 'CMO', 'CIO', 'CISO',
                'President', 'Vice President', 'VP', 'Director', 'Manager',
                'Engineer', 'Developer', 'Designer', 'Architect', 'Analyst',
                'Lead', 'Senior', 'Principal', 'Head', 'Chief',
                'Founder', 'Co-Founder', 'Partner', 'Consultant',
                'Specialist', 'Coordinator', 'Administrator'
            ];

            // Search through results
            for (const result of searchResults) {
                const text = (result.text || result.content || '').substring(0, 2000);

                // Try each pattern
                for (const pattern of titlePatterns) {
                    const match = text.match(pattern);
                    if (match && match[1]) {
                        const potentialTitle = match[1].trim();
                        // Verify it contains a title keyword
                        if (titleKeywords.some(keyword => potentialTitle.toLowerCase().includes(keyword.toLowerCase()))) {
                            return potentialTitle;
                        }
                    }
                }
            }

            return '';
        } catch (e) {
            console.error('Error extracting title from web results:', e);
            return '';
        }
    }

    /**
     * Helper: Count interactions per attendee
     */
    countInteractions(attendees, emails, calendarEvents) {
        const counts = {};

        attendees.forEach(att => {
            const email = att.email.toLowerCase();
            let count = 0;

            emails.forEach(e => {
                if (e.from?.toLowerCase().includes(email) || e.to?.toLowerCase().includes(email)) {
                    count++;
                }
            });

            calendarEvents.forEach(event => {
                if (event.attendees?.some(a => a.email.toLowerCase() === email)) {
                    count++;
                }
            });

            counts[att.name || att.email] = count;
        });

        return Object.entries(counts)
            .map(([name, count]) => `${name}: ${count} interactions`)
            .join('\n');
    }

    /**
     * Helper: Analyze email patterns
     */
    analyzeEmailPatterns(attendees, emails) {
        const patterns = [];

        attendees.forEach(att => {
            const email = att.email.toLowerCase();
            const attendeeEmails = emails.filter(e =>
                e.from?.toLowerCase().includes(email) ||
                e.to?.toLowerCase().includes(email)
            );

            if (attendeeEmails.length > 0) {
                const mostRecent = attendeeEmails[0];
                patterns.push(`${att.name || att.email}: Last contact ${mostRecent.date} - "${mostRecent.subject}"`);
            }
        });

        return patterns.length > 0 ? patterns.join('\n') : 'No recent email patterns';
    }

    /**
     * Research companies using Parallel API (ORIGINAL)
     */
    async researchCompaniesWithParallel(attendeesAnalysis, meeting) {
        if (!attendeesAnalysis || attendeesAnalysis.length === 0) {
            return 'No company information available.';
        }

        // Extract unique companies
        const companies = {};
        attendeesAnalysis.forEach(att => {
            if (att.company) {
                if (!companies[att.company]) {
                    companies[att.company] = [];
                }
                companies[att.company].push(att.name);
            }
        });

        if (Object.keys(companies).length === 0) {
            return 'No company information available.';
        }

        // If no Parallel API, just list companies
        if (!this.parallelClient) {
            return Object.entries(companies)
                .map(([company, people]) => `${company}: ${people.join(', ')}`)
                .join('\n');
        }

        try {
            console.log(`   🌐 Researching ${Object.keys(companies).length} companies with Parallel API...`);

            const companyList = Object.keys(companies).join(', ');

            // Craft search queries
            const searchQueries = await this.craftSearchQueries(
                `Meeting: ${meeting?.summary || 'Business Meeting'}
Companies: ${companyList}

Generate 3 highly specific web search queries to find:
1. Recent company news, announcements, or press releases
2. Funding rounds, acquisitions, or business developments
3. Product launches, partnerships, or strategic initiatives

Focus on recent (last 6 months) verifiable information.`
            );

            if (searchQueries.length === 0) {
                console.log(`   ⚠️  No search queries generated for companies`);
                return Object.entries(companies)
                    .map(([company, people]) => `${company}: ${people.join(', ')}`)
                    .join('\n');
            }

            // PARALLELIZATION: Execute all company search queries simultaneously
            const searchResults = [];
            const searchPromises = searchQueries.map(async (query) => {
                try {
                                    const result = await this.parallelClient.beta.search({
                                        objective: query,
                                        search_queries: [query],
                                        mode: 'one-shot',
                                        max_results: 4, // Reduced from 6 to 4
                                        max_chars_per_result: 2000 // Reduced from 2500 to 2000
                                    });

                    if (result && result.results) {
                        searchResults.push(...result.results);
                    }
                    console.log(`   ✅ Company search completed: ${query.substring(0, 50)}...`);
                } catch (e) {
                    console.error(`   ⚠️  Company search failed: ${query.substring(0, 50)}...`, e.message);
                }
            });

            await Promise.allSettled(searchPromises);

            if (searchResults.length === 0) {
                console.log(`   ⚠️  No company search results found`);
                return Object.entries(companies)
                    .map(([company, people]) => `${company}: ${people.join(', ')}`)
                    .join('\n');
            }

            // Synthesize company research
            const research = await this.synthesizeResults(
                `Analyze these company search results and extract key business intelligence relevant for the meeting.

Focus on:
- Recent company news, announcements, or developments (last 6 months)
- Funding rounds, acquisitions, partnerships, or strategic initiatives
- Product launches or major feature releases

Return a well-structured summary (2-3 sentences per company) that provides actionable intelligence for meeting preparation.`,
                JSON.stringify(searchResults).substring(0, 8000), // Reduced from 12000 to 8000
                500 // Reduced from 800 to 500 tokens
            );

            console.log(`   ✅ Company research synthesized`);
            return research || 'No significant company developments found.';

        } catch (error) {
            console.error(`   ⚠️  Company research error:`, error.message);
            return Object.entries(companies)
                .map(([company, people]) => `${company}: ${people.join(', ')}`)
                .join('\n');
        }
    }

    /**
     * ORIGINAL HELPER: Craft search queries using GPT
     */
    async craftSearchQueries(context) {
        try {
            const result = await this.callGPT({
                systemPrompt: 'Generate EXACTLY 3 highly specific web search queries that will find the most relevant and recent information. Return ONLY a JSON array of query strings, nothing else. Format: {"queries": ["query1", "query2", "query3"]}',
                userPrompt: context,
                maxTokens: 200,
                temperature: 0.7,
                responseFormat: 'json_array'
            });

            // Handle both array and object responses
            if (Array.isArray(result)) {
                return result.slice(0, 3);
            } else if (result && typeof result === 'object') {
                const queries = result.queries || result.items || [];
                return Array.isArray(queries) ? queries.slice(0, 3) : [];
            }

            return [];
        } catch (error) {
            console.error('Error crafting queries:', error);
            return [];
        }
    }

    /**
     * ORIGINAL HELPER: Synthesize results with strict fact-checking
     */
    async synthesizeResults(prompt, data, maxTokens = 500) {
        try {
            const result = await this.callGPT({
                systemPrompt: `You are an executive briefing expert. Extract meaningful, verified information from the provided data.

Rules:
1. ONLY include facts directly supported by the data provided
2. Be specific and concrete - include numbers, dates, companies, titles, achievements
3. Each fact should be complete and clear (15-80 words is ideal)
4. Skip generic statements
5. Focus on recent activities, achievements, roles, and specific expertise
6. Return information that would be genuinely useful in a business meeting context`,
                userPrompt: `${prompt}\n\nData:\n${typeof data === 'string' ? data.substring(0, 12000) : JSON.stringify(data).substring(0, 12000)}`,
                maxTokens,
                temperature: 0.7
            });

            return result;
        } catch (error) {
            console.error('Error synthesizing:', error);
            return null;
        }
    }
}

module.exports = BriefAnalyzer;
