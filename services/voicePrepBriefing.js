/**
 * Voice Prep Briefing Service - 2-Minute Meeting Preparation (Shadow Style)
 *
 * Architecture: OpenAI Realtime API (voice-to-voice)
 *
 * Features:
 * - Shadow-style executive briefing (250-280 words in 2 minutes)
 * - 8-section structure: Snapshot → Attendees → Touchpoints → Opportunities → Risks → Levers → Rapport → Recommendation
 * - Seamless interruption handling (no meta-phrases, natural resumption)
 * - Low-latency streaming (~320ms target)
 * - ChatGPT voice mode quality
 * - Native voice-to-voice (no separate STT/TTS)
 */

const OpenAIRealtimeManager = require('./openaiRealtime');
const logger = require('./logger');

// Briefing sections with time allocations (milliseconds)
const BRIEFING_SECTIONS = {
    INTRO: { name: 'Introduction', duration: 10000, order: 1 },
    ATTENDEES: { name: 'Attendees', duration: 40000, order: 2 },
    INSIGHTS: { name: 'Key Insights', duration: 30000, order: 3 },
    AGENDA: { name: 'Meeting Agenda', duration: 20000, order: 4 },
    RECOMMENDATIONS: { name: 'Recommendations', duration: 15000, order: 5 },
    QA: { name: 'Q&A', duration: null, order: 6 } // Open-ended
};

const TOTAL_BRIEFING_TIME = 115000; // 1:55 (leave 5s buffer for Q&A transition)

// States
const States = {
    INITIALIZING: 'initializing',
    BRIEFING: 'briefing',
    INTERRUPTED: 'interrupted',
    QA_MODE: 'qa_mode',
    ENDED: 'ended'
};

class VoicePrepManager {
    constructor(meetingBrief, openaiApiKey, userContext = null) {
        this.brief = meetingBrief;
        this.openaiApiKey = openaiApiKey;
        this.userContext = userContext; // Store user context
        this.fetch = require('node-fetch'); // For GPT API calls

        // State management
        this.state = States.INITIALIZING;
        this.currentSection = null;
        this.sectionStartTime = null;
        this.briefingStartTime = null;
        this.elapsedTime = 0;

        // Realtime API manager
        this.realtimeManager = null;

        // WebSocket reference
        this.ws = null;

        // Conversation history
        this.conversationHistory = [];
        this.briefingDelivered = false;

        // Timer for section transitions
        this.sectionTimer = null;
        this.elapsedTimer = null;
        
        // Interruption handling
        this.interruptedAt = null;
        this.resumeText = null;
        this.lastQuestionHash = null; // Track last question to prevent duplicates
        
        // Transcript deduplication
        this.lastSentTranscript = null;
        this.lastSentTranscriptTime = null;
    }

    /**
     * Initialize voice prep briefing
     */
    async connect(ws) {
        this.ws = ws;
        this.briefingStartTime = Date.now();

        try {
            // Build system prompt dynamically using GPT
            const systemPrompt = await this.buildBriefingPrompt();

            // Initialize Realtime API manager
            this.realtimeManager = new OpenAIRealtimeManager(
                this.openaiApiKey,
                systemPrompt,
                this.userContext
            );

            // Set up event handlers
            this.realtimeManager.onTranscript = (transcript) => {
                this.handleTranscript(transcript);
            };

            this.realtimeManager.onAudioChunk = (audioChunk) => {
                // Audio chunks are already forwarded to client by RealtimeManager
                // Just update state
                if (this.state === States.BRIEFING) {
                    this.state = States.BRIEFING; // Keep briefing state
                }
            };

            this.realtimeManager.onSpeechStarted = () => {
                // User started speaking - cancellation is handled by openaiRealtime.js
                // Update UI state to reflect interruption
                if (this.state === States.BRIEFING || this.realtimeManager.isSpeaking) {
                    logger.info('User started speaking during briefing - handling interruption');
                    // Update state for UI feedback
                    this.state = States.INTERRUPTED;
                    this.interruptedAt = Date.now();
                    this.sendToClient({
                        type: 'voice_prep_interrupted',
                        message: 'Listening...'
                    });
                }
            };

            this.realtimeManager.onSpeechStopped = () => {
                logger.debug('User stopped speaking');
            };

            this.realtimeManager.onError = (error) => {
                logger.error({ error: error.message }, 'Realtime API error');
                this.sendToClient({
                    type: 'error',
                    message: 'Voice briefing error'
                });
            };

            this.realtimeManager.onDisconnect = () => {
                logger.info('Realtime API disconnected');
                this.state = States.ENDED;
            };

            // Connect to Realtime API
            await this.realtimeManager.connect(ws);

            logger.info('🎤 Voice Prep Briefing initialized with Realtime API');

            // Wait for session to be fully updated before starting briefing
            // The session.update message needs to be processed first
            await new Promise(resolve => setTimeout(resolve, 500));

        // Send ready message
        this.sendToClient({
            type: 'voice_prep_ready',
            message: 'Starting your 2-minute briefing...'
        });

        // Start the elapsed time tracker
        this.startElapsedTimer();

        // Begin the structured briefing
        await this.startBriefing();

        } catch (error) {
            logger.error({ error: error.message }, 'Failed to initialize voice prep briefing');
            this.sendToClient({
                type: 'error',
                message: 'Failed to start voice briefing'
            });
        }
    }

    /**
     * Handle transcript from Realtime API
     */
    handleTranscript(transcript) {
        const { text, isFinal } = transcript;

        // Skip partial transcripts - only process final transcripts to avoid duplication
        if (!isFinal) {
            return; // Don't send or process partial transcripts
        }

        // Handle final transcript (user finished speaking)
        if (isFinal && text.trim()) {
            const trimmedText = text.trim();
            const now = Date.now();
            
            // Deduplicate: Don't send the same final transcript twice within 2 seconds
            if (this.lastSentTranscript === trimmedText && 
                this.lastSentTranscriptTime && 
                (now - this.lastSentTranscriptTime) < 2000) {
                logger.debug('Duplicate final transcript detected, skipping', { text: trimmedText.substring(0, 50) });
                return;
            }
            
            logger.info({ text: trimmedText }, 'User question received');

            // User interrupted or asked a question
            if (this.state === States.BRIEFING) {
                logger.info('User interrupted briefing');
                this.handleInterruption();
            }

            // Track sent transcript for deduplication
            this.lastSentTranscript = trimmedText;
            this.lastSentTranscriptTime = now;

            // Send final transcript to client
            this.sendToClient({
                type: 'voice_prep_transcript',
                text: trimmedText,
                isFinal: true,
                speaker: 'You'
            });

            // Process the user's question
            this.handleUserQuestion(trimmedText);
        }
    }

    /**
     * Start the structured 2-minute briefing
     */
    async startBriefing() {
        // Wait for session to be ready before starting briefing
        if (!this.realtimeManager || !this.realtimeManager.isConnected || !this.realtimeManager.sessionId) {
            logger.info('Waiting for Realtime API session to be ready...');
            // Wait for session.created event
            await new Promise((resolve) => {
                const checkInterval = setInterval(() => {
                    if (this.realtimeManager && this.realtimeManager.isConnected && this.realtimeManager.sessionId) {
                        clearInterval(checkInterval);
                        logger.info('Realtime API session ready, starting briefing');
                        resolve();
                    }
                }, 100);
                // Timeout after 5 seconds
                setTimeout(() => {
                    clearInterval(checkInterval);
                    logger.warn('Timeout waiting for Realtime API session');
                    resolve();
                }, 5000);
            });
        }

        this.state = States.BRIEFING;
        this.briefingDelivered = false;

        // Send direct instruction to start briefing
        if (this.realtimeManager && this.realtimeManager.isConnected && this.realtimeManager.sessionId) {
            logger.info('Sending briefing start instruction to Realtime API');
            this.realtimeManager.sendTextInput('Begin the 2-minute briefing immediately.');
            
            // Small delay to ensure text input is processed
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Request response immediately
            logger.info('Requesting response from Realtime API');
            this.realtimeManager.requestResponse();
        } else {
            logger.error('Cannot start briefing: Realtime API not connected or session not ready', {
                isConnected: this.realtimeManager?.isConnected,
                sessionId: this.realtimeManager?.sessionId
            });
            this.sendToClient({
                type: 'error',
                message: 'Failed to start briefing - connection not ready'
            });
        }
    }

    /**
     * Build Shadow-style executive briefing prompt dynamically using GPT
     * Generates comprehensive system prompt with attendee names, meeting context, and transcription hints
     */
    async buildBriefingPrompt() {
        const meeting = this.brief;
        
        // Detect day prep mode: check for narrative and date fields
        if (meeting.narrative && meeting.date) {
            logger.info('Detected day prep mode - using day prep prompt builder');
            return await this.buildDayPrepPrompt();
        }
        
        // Meeting prep mode (existing logic)
        let attendees = meeting.attendees || [];
        
        // Filter out the user from attendees list
        if (this.userContext && this.userContext.email) {
            attendees = attendees.filter(att => {
                const attendeeEmail = (att.email || att.emailAddress || '').toLowerCase();
                return attendeeEmail !== this.userContext.email.toLowerCase();
            });
        }
        
        // Extract all attendee names (first names, full names, variations) for transcription hints
        const attendeeNameList = attendees
            .map(a => {
                const name = a.name || '';
                const parts = name.split(' ');
                return [name, parts[0], parts[parts.length - 1]].filter(Boolean);
            })
            .flat()
            .filter((name, index, self) => self.indexOf(name) === index); // Remove duplicates
        
        const attendeeNames = attendees.map(a => a.name).filter(Boolean).join(' and ') || 'the other attendees';
        
        // FIX: Get meeting title from context.meeting or original meeting object, not brief.summary
        const meetingTitle = (meeting.context && meeting.context.meeting && meeting.context.meeting.summary) 
            || meeting.summary 
            || meeting.title 
            || 'this meeting';
        
        // FIX: Get meeting time from context.meeting or original meeting object
        const meetingTime = (meeting.context && meeting.context.meeting && meeting.context.meeting.start?.dateTime)
            || meeting.start?.dateTime 
            || meeting.start?.date 
            || 'upcoming';
        
        const companies = [...new Set(attendees.map(a => a.company).filter(Boolean))];
        
        // Extract all meeting context fields
        const relationshipNotes = meeting.relationshipAnalysis || 'No prior interaction history available.';
        const emailContext = meeting.emailAnalysis || 'No recent email exchanges.';
        const documentContext = meeting.documentAnalysis || 'No shared documents.';
        const companyResearch = meeting.companyResearch || 'No company research available.';
        const actionItems = meeting.actionItems || [];
        const timeline = meeting.timeline || [];
        const contributionAnalysis = meeting.contributionAnalysis || 'No contribution analysis available.';
        const broaderNarrative = meeting.broaderNarrative || 'No broader narrative available.';
        const recommendations = meeting.recommendations || [];

        const userName = this.userContext ? this.userContext.formattedName : 'the user';
        const userEmail = this.userContext ? this.userContext.formattedEmail : '';
        
        // Prepare context for GPT to generate system prompt structure
        const contextForGPT = {
            userName,
            userEmail,
            meetingTitle,
            meetingTime,
            attendeeNames: attendeeNameList,
            companies,
            attendeeCount: attendees.length
        };

        try {
            // Use GPT to generate the STRUCTURE of the system prompt
            const promptStructure = await this.generateSystemPromptStructure(contextForGPT);
            logger.info('Generated dynamic system prompt structure using GPT');
            
            // Now explicitly append ALL attendee details and meeting information
            const fullPrompt = this.buildFullSystemPrompt(promptStructure, {
                userName,
                userEmail,
                meetingTitle,
                meetingTime,
                attendeeNames: attendeeNameList,
                companies,
                attendees,
                relationshipNotes,
                emailContext,
                documentContext,
                companyResearch,
                actionItems,
                timeline,
                contributionAnalysis,
                broaderNarrative,
                recommendations
            });
            
            return fullPrompt;
        } catch (error) {
            logger.error('Failed to generate dynamic system prompt, using fallback', error);
            // Fallback to basic prompt if GPT generation fails
            return this.buildFallbackPrompt({
                userName,
                userEmail,
                meetingTitle,
                meetingTime,
                attendeeNames: attendeeNameList,
                companies,
                attendees: attendees.map(att => ({
                    name: att.name,
                    email: att.email,
                    title: att.title,
                    company: att.company,
                    keyFacts: att.keyFacts || []
                })),
                relationshipNotes,
                emailContext,
                documentContext,
                companyResearch,
                actionItems,
                timeline,
                contributionAnalysis,
                broaderNarrative,
                recommendations
            });
        }
    }

    /**
     * Generate system prompt STRUCTURE using GPT (just the framework, not the data)
     */
    async generateSystemPromptStructure(context) {
        const systemPromptForGPT = `You are an expert at creating system prompt structures for voice AI assistants. Generate a well-structured system prompt framework for Shadow, an executive assistant AI.

The prompt structure should:
1. Include transcription hints section (with placeholder for attendee names)
2. Include Shadow's role and persona
3. Include briefing instructions (150-180 words, concise, Shadow's style)
4. Include interruption handling rules
5. Include response format requirements
6. Be well-structured and comprehensive
7. CRITICAL: Always use [USER_NAME] placeholder and instruct to refer to the user by their actual name, NOT "user" or "the user"

Format: Return ONLY the system prompt structure text with placeholders like [ATTENDEE_NAMES], [MEETING_TITLE], [USER_NAME], etc. No markdown, no explanations.`;

        const userPrompt = `Generate a system prompt structure for Shadow briefing ${context.userName} about a meeting.

CRITICAL: The prompt must use [USER_NAME] placeholder and instruct Shadow to refer to ${context.userName} by their actual name "${context.userName}", NOT "user" or "the user". Always use "you" to refer to ${context.userName} when speaking.

MEETING OVERVIEW:
- Title: [MEETING_TITLE]
- Time: [MEETING_TIME]
- Attendee Count: ${context.attendeeCount}
- Companies: ${context.companies.join(', ')}

The structure should include placeholders for:
- [ATTENDEE_NAMES] - list of attendee names for transcription hints
- [MEETING_TITLE] - meeting title
- [MEETING_TIME] - meeting time
- [USER_NAME] - user's name
- [USER_EMAIL] - user's email
- [ATTENDEE_DETAILS_SECTION] - comprehensive attendee information section
- [MEETING_CONTEXT_SECTION] - comprehensive meeting context section

Generate a comprehensive system prompt structure that Shadow can use to deliver voice briefings.`;

        const response = await this.fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.openaiApiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-5',
                temperature: 0.7,
                messages: [
                    { role: 'system', content: systemPromptForGPT },
                    { role: 'user', content: userPrompt }
                ],
                max_completion_tokens: 4000
            })
        });

        if (!response.ok) {
            throw new Error(`GPT API error: ${response.status}`);
        }

        const data = await response.json();
        return data.choices[0].message.content.trim();
    }

    /**
     * Build full system prompt by replacing placeholders with actual data
     */
    buildFullSystemPrompt(structure, data) {
        // Build comprehensive attendee details section
        const attendeeDetailsSection = data.attendees.length > 0
            ? `\n\n=== ATTENDEE INFORMATION ===\n` +
              data.attendees.map(att => {
                  const name = att.name || 'Unknown attendee';
                  const email = att.email || 'No email';
                  const title = att.title || 'Role unknown';
                  const company = att.company || 'Company unknown';
                  const keyFacts = att.keyFacts && att.keyFacts.length > 0 
                      ? att.keyFacts.join('\n  • ') 
                      : 'Limited context available';
                  
                  return `${name} (${email})
  Role: ${title}
  Company: ${company}
  Key Facts:
  • ${keyFacts}`;
              }).join('\n\n')
            : 'No attendee information available.';

        // Build comprehensive meeting context section
        const meetingContextSection = `=== MEETING CONTEXT ===

Meeting: ${data.meetingTitle}
When: ${data.meetingTime}
Companies Involved: ${data.companies.join(', ') || 'Various'}

RELATIONSHIP ANALYSIS:
${data.relationshipNotes}

EMAIL CONTEXT:
${data.emailContext}

DOCUMENT CONTEXT:
${data.documentContext}

COMPANY RESEARCH:
${data.companyResearch}

CONTRIBUTION ANALYSIS:
${data.contributionAnalysis}

BROADER NARRATIVE:
${data.broaderNarrative}

RECOMMENDATIONS:
${data.recommendations.length > 0 ? data.recommendations.join('\n• ') : 'None provided.'}

ACTION ITEMS:
${data.actionItems.length > 0 ? data.actionItems.join('\n• ') : 'None provided.'}

TIMELINE EVENTS (${data.timeline.length} events):
${data.timeline.length > 0 
    ? data.timeline.slice(0, 10).map((event, idx) => {
        const date = event.date || event.start?.dateTime || 'Date unknown';
        const type = event.type || 'event';
        const title = event.title || event.summary || 'Untitled';
        return `${idx + 1}. [${date}] ${type}: ${title}`;
      }).join('\n')
    : 'No timeline events available.'}`;

        // Replace placeholders in structure
        let fullPrompt = structure
            .replace(/\[ATTENDEE_NAMES\]/g, data.attendeeNames.join(', '))
            .replace(/\[MEETING_TITLE\]/g, data.meetingTitle)
            .replace(/\[MEETING_TIME\]/g, data.meetingTime)
            .replace(/\[USER_NAME\]/g, data.userName)
            .replace(/\[USER_EMAIL\]/g, data.userEmail)
            .replace(/\[ATTENDEE_DETAILS_SECTION\]/g, attendeeDetailsSection)
            .replace(/\[MEETING_CONTEXT_SECTION\]/g, meetingContextSection);

        // If placeholders weren't used, append sections at the end
        if (!structure.includes('[ATTENDEE_DETAILS_SECTION]')) {
            fullPrompt += attendeeDetailsSection;
        }
        if (!structure.includes('[MEETING_CONTEXT_SECTION]')) {
            fullPrompt += '\n\n' + meetingContextSection;
        }

        // Add transcription hints if not already included
        if (!fullPrompt.includes('transcription') && !fullPrompt.includes('Transcription')) {
            fullPrompt += `\n\n=== TRANSCRIPTION ACCURACY HINTS ===
When transcribing user speech, pay special attention to these names: ${data.attendeeNames.join(', ')}. These are meeting attendees and should be transcribed accurately.`;
        }

        return fullPrompt;
    }

    /**
     * Fallback prompt if GPT generation fails - includes ALL data explicitly
     */
    buildFallbackPrompt(context) {
        const transcriptionHints = context.attendeeNames.length > 0 
            ? `\n\nTRANSCRIPTION ACCURACY HINTS:\nWhen transcribing user speech, pay special attention to these names: ${context.attendeeNames.join(', ')}. These are meeting attendees and should be transcribed accurately.\n`
            : '';

        // Build comprehensive attendee details
        const attendeeDetails = context.attendees.length > 0
            ? context.attendees.map(att => {
                const name = att.name || 'Unknown attendee';
                const email = att.email || 'No email';
                const title = att.title || 'Role unknown';
                const company = att.company || 'Company unknown';
                const keyFacts = att.keyFacts && att.keyFacts.length > 0 
                    ? att.keyFacts.join('\n    • ') 
                    : 'Limited context available';
                
                return `  ${name} (${email})
    Role: ${title}
    Company: ${company}
    Key Facts:
    • ${keyFacts}`;
            }).join('\n\n')
            : '  No attendee information available.';

        // Build comprehensive meeting context
        const meetingContext = `Meeting: ${context.meetingTitle}
When: ${context.meetingTime}
Companies: ${context.companies.join(', ') || 'Various'}

RELATIONSHIP ANALYSIS:
${context.relationshipNotes}

EMAIL CONTEXT:
${context.emailContext}

DOCUMENT CONTEXT:
${context.documentContext}

COMPANY RESEARCH:
${context.companyResearch}

CONTRIBUTION ANALYSIS:
${context.contributionAnalysis || 'No contribution analysis available.'}

BROADER NARRATIVE:
${context.broaderNarrative || 'No broader narrative available.'}

RECOMMENDATIONS:
${context.recommendations && context.recommendations.length > 0 
    ? context.recommendations.map(r => `• ${r}`).join('\n')
    : 'None provided.'}

ACTION ITEMS:
${context.actionItems && context.actionItems.length > 0 
    ? context.actionItems.map(a => `• ${a}`).join('\n')
    : 'None provided.'}

TIMELINE EVENTS:
${context.timeline && context.timeline.length > 0 
    ? context.timeline.slice(0, 10).map((event, idx) => {
        const date = event.date || event.start?.dateTime || 'Date unknown';
        const type = event.type || 'event';
        const title = event.title || event.summary || 'Untitled';
        return `${idx + 1}. [${date}] ${type}: ${title}`;
      }).join('\n')
    : 'No timeline events available.'}`;

        return `You are Shadow, ${context.userName}'s hyper-contextual executive assistant. Deliver a precise, calm, powerful voice brief.

IMPORTANT: You are briefing ${context.userName} (${context.userEmail}). Use "you" to refer to ${context.userName}. Structure everything from ${context.userName}'s perspective. The attendees listed are OTHER people (excluding ${context.userName}).

RULES:
- Maximum 90 seconds (150-180 words total) - BE CONCISE
- Start fast, no fluff, no preamble
- Every sentence must add value - cut any filler
- Prioritize only what changes decisions or behavior
- Surface the 10% insights that give 90% advantage
- Simple, high-clarity language
- Voice style: Calm, confident Chief of Staff whispering the essentials

=== ATTENDEE INFORMATION ===
${attendeeDetails}

=== MEETING CONTEXT ===
${meetingContext}
${transcriptionHints}
YOUR VOICE BRIEF STRUCTURE (150-180 words total):

1. Quick Situation Snapshot (15 seconds / ~25-30 words)
2. Attendee Decode (25 seconds / ~40-50 words)
3. Last Touchpoints (20 seconds / ~30-35 words)
4. Key Points (20 seconds / ~30-35 words)
5. Shadow's Recommendation (10 seconds / ~20-25 words)

INTERRUPTION RULES (CRITICAL):
- When user interrupts: STOP IMMEDIATELY
- Answer their question directly using meeting context (<15 seconds)
- Then RESUME from the EXACT sentence you left off
- NO meta-phrases: NEVER say "Let me pause", "As I was saying", "Do you want me to resume", "Should I continue", "Where was I"
- Resume naturally with NO repetition, NO restarting, NO explanations

RESPONSE FORMAT:
- Output ONLY the speech text
- NO markdown, NO formatting, NO stage directions
- Speak as Shadow: calm, confident, concise
- Maximum 180 words - if you exceed this, cut content, not quality
- Every word counts - be ruthless about brevity

CRITICAL: You have access to comprehensive attendee information above. When answering questions about attendees, use their full key facts and context. When asked "Who is [name]?", provide detailed information from the attendee information section above.`;
    }

    /**
     * Handle user interruption during briefing
     * NOTE: OpenAI Realtime API handles interruption automatically via server_vad
     * This method is kept for backward compatibility but no longer manually cancels responses
     */
    handleInterruption() {
        // Update state for UI feedback
        this.state = States.INTERRUPTED;
        this.interruptedAt = Date.now();

        // Send interruption notification to client
        this.sendToClient({
            type: 'voice_prep_interrupted',
            message: 'Listening...'
        });

        logger.info('Briefing interrupted, listening for question (API handling cancellation)');
    }

    /**
     * Handle user's question (during briefing or Q&A)
     */
    handleUserQuestion(question) {
        // Deduplicate: prevent processing the same question twice
        const questionHash = question.trim().toLowerCase();
        if (this.lastQuestionHash === questionHash) {
            logger.debug('Duplicate question detected, skipping', { question });
            return;
        }
        this.lastQuestionHash = questionHash;

        // Check if this is the first question after briefing
        const elapsedTime = Date.now() - this.briefingStartTime;
        if (elapsedTime > TOTAL_BRIEFING_TIME && !this.briefingDelivered) {
            // Briefing time elapsed, switch to Q&A mode
            this.state = States.QA_MODE;
            this.briefingDelivered = true;
            this.sendToClient({
                type: 'voice_prep_section_change',
                section: 'Q&A',
                message: 'Now in Q&A mode'
            });
        }

        // Send question to Realtime API
        if (!this.realtimeManager) {
            logger.error('Cannot handle question: realtimeManager not available');
            return;
        }

        // Simplified: Always cancel first if speaking, then send input and request response
        const processQuestion = () => {
            logger.info('Processing user question', { question, isSpeaking: this.realtimeManager.isSpeaking });
            
            // Send the question as text input
            this.realtimeManager.sendTextInput(question);
            
            // Small delay to ensure input is processed before requesting response
            setTimeout(() => {
                // Request response - this will be blocked if cancellation is still in progress
                this.realtimeManager.requestResponse();
                
                // Update state
                if (this.state === States.INTERRUPTED) {
                    this.state = States.BRIEFING;
                }
            }, 100);
        };

        // If AI is speaking, cancel first, then process
        if (this.realtimeManager.isSpeaking || this.realtimeManager.isCancelling) {
            logger.info('AI is speaking, cancelling before processing question...');
            // Cancel the response
            this.realtimeManager.cancelResponse();
            
            // Wait briefly for cancellation, then process question
            // The requestResponse() call will be blocked if cancellation isn't complete
            setTimeout(processQuestion, 300);
        } else {
            // No active response, process immediately
            processQuestion();
        }
    }

    // Note: Response generation and TTS are now handled by Realtime API
    // The Realtime API automatically generates audio responses

    /**
     * Start elapsed time tracker
     */
    startElapsedTimer() {
        this.elapsedTimer = setInterval(() => {
            this.elapsedTime = Date.now() - this.briefingStartTime;

            // Send elapsed time update
            this.sendToClient({
                type: 'voice_prep_time_update',
                elapsed: this.elapsedTime,
                total: 120000 // 2 minutes
            });

            // Auto-transition to Q&A after 2 minutes if still in briefing
            if (this.elapsedTime >= TOTAL_BRIEFING_TIME && this.state === States.BRIEFING && !this.briefingDelivered) {
                console.log('⏰ 2-minute briefing time elapsed, transitioning to Q&A');
                this.state = States.QA_MODE;
                this.briefingDelivered = true;
                this.sendToClient({
                    type: 'voice_prep_section_change',
                    section: 'Q&A',
                    message: 'Briefing complete - Q&A mode'
                });
            }
        }, 1000); // Update every second
    }

    /**
     * Send audio data to Realtime API
     */
    sendAudio(audioData) {
        if (this.realtimeManager && this.realtimeManager.isConnected) {
            this.realtimeManager.sendAudioInput(audioData);
        }
    }
    
    /**
     * Commit audio buffer (trigger transcription)
     */
    commitAudioBuffer() {
        if (this.realtimeManager && this.realtimeManager.isConnected) {
            this.realtimeManager.commitAudioBuffer();
        }
    }

    /**
     * Send message to client via WebSocket
     */
    sendToClient(message) {
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify(message));
        }
    }

    /**
     * Disconnect and cleanup
     */
    disconnect() {
        logger.info('Disconnecting voice prep briefing');

        // Clear timers
        if (this.sectionTimer) {
            clearTimeout(this.sectionTimer);
            this.sectionTimer = null;
        }

        if (this.elapsedTimer) {
            clearInterval(this.elapsedTimer);
            this.elapsedTimer = null;
        }

        // Disconnect Realtime API
        if (this.realtimeManager) {
            this.realtimeManager.disconnect();
            this.realtimeManager = null;
        }

        // Update state
        this.state = States.ENDED;
        this.conversationHistory = [];
    }

    /**
     * Build system prompt for day prep mode
     * Includes narrative, all individual meeting briefs, aggregated attendees, and context
     */
    async buildDayPrepPrompt() {
        const dayPrep = this.brief;
        const narrative = dayPrep.narrative || '';
        const date = dayPrep.date || 'today';
        const meetings = dayPrep.meetings || []; // Full meeting briefs
        const aggregatedAttendees = dayPrep.aggregatedAttendees || [];
        const aggregatedContext = dayPrep.aggregatedContext || {};
        const attendeeNames = dayPrep.attendeeNames || [];

        const userName = this.userContext ? this.userContext.formattedName : 'the user';
        const userEmail = this.userContext ? this.userContext.formattedEmail : '';

        // Extract all attendee names for transcription hints
        const allAttendeeNames = attendeeNames.length > 0 ? attendeeNames : aggregatedAttendees
            .map(a => {
                const name = a.name || '';
                const parts = name.split(' ');
                return [name, parts[0], parts[parts.length - 1]].filter(Boolean);
            })
            .flat()
            .filter((name, index, self) => self.indexOf(name) === index);

        // Prepare context for GPT to generate system prompt structure
        const contextForGPT = {
            userName,
            userEmail,
            date,
            meetingCount: meetings.length,
            attendeeCount: aggregatedAttendees.length,
            attendeeNames: allAttendeeNames
        };

        try {
            // Use GPT to generate the STRUCTURE of the system prompt
            const promptStructure = await this.generateDayPrepPromptStructure(contextForGPT);
            logger.info('Generated dynamic day prep system prompt structure using GPT');

            // Build comprehensive attendee details section
            const attendeeDetailsSection = aggregatedAttendees.length > 0
                ? `\n\n=== ATTENDEE INFORMATION ===\n` +
                  aggregatedAttendees.map(att => {
                      const name = att.name || 'Unknown attendee';
                      const email = att.email || 'No email';
                      const title = att.title || 'Role unknown';
                      const company = att.company || 'Company unknown';
                      const keyFacts = att.keyFacts && att.keyFacts.length > 0 
                          ? att.keyFacts.join('\n  • ') 
                          : 'Limited context available';
                      
                      return `${name} (${email})
  Role: ${title}
  Company: ${company}
  Key Facts:
  • ${keyFacts}`;
                  }).join('\n\n')
                : 'No attendee information available.';

            // Build individual meeting briefs section
            const meetingBriefsSection = meetings.length > 0
                ? `\n\n=== INDIVIDUAL MEETING BRIEFS ===\n` +
                  meetings.map((brief, idx) => {
                      const meetingTitle = brief.summary || brief.title || `Meeting ${idx + 1}`;
                      const meetingTime = brief.start?.dateTime || brief.start?.date || 'Time TBD';
                      const briefAttendees = brief.attendees || [];
                      
                      return `Meeting ${idx + 1}: ${meetingTitle}
Time: ${meetingTime}
Attendees: ${briefAttendees.map(a => `${a.name || 'Unknown'}${a.company ? ` (${a.company})` : ''}`).join(', ')}

Summary: ${brief.summary || 'No summary available.'}

Relationship Analysis: ${brief.relationshipAnalysis || 'No relationship analysis.'}
Email Context: ${brief.emailAnalysis || 'No email context.'}
Document Context: ${brief.documentAnalysis || 'No document context.'}
Company Research: ${brief.companyResearch || 'No company research.'}
Recommendations: ${brief.recommendations && brief.recommendations.length > 0 ? brief.recommendations.join('; ') : 'None'}
Action Items: ${brief.actionItems && brief.actionItems.length > 0 ? brief.actionItems.join('; ') : 'None'}`;
                  }).join('\n\n---\n\n')
                : 'No individual meeting briefs available.';

            // Build aggregated context section
            const aggregatedContextSection = `=== AGGREGATED CONTEXT ACROSS ALL MEETINGS ===

Relationship Analysis:
${aggregatedContext.relationshipAnalysis || 'No relationship analysis available.'}

Email Context:
${aggregatedContext.emailAnalysis || 'No email context available.'}

Document Context:
${aggregatedContext.documentAnalysis || 'No document context available.'}

Company Research:
${aggregatedContext.companyResearch || 'No company research available.'}

Contribution Analysis:
${aggregatedContext.contributionAnalysis || 'No contribution analysis available.'}

Broader Narrative:
${aggregatedContext.broaderNarrative || 'No broader narrative available.'}

Recommendations:
${aggregatedContext.recommendations && aggregatedContext.recommendations.length > 0 
    ? aggregatedContext.recommendations.join('\n• ') 
    : 'None provided.'}

Action Items:
${aggregatedContext.actionItems && aggregatedContext.actionItems.length > 0 
    ? aggregatedContext.actionItems.join('\n• ') 
    : 'None provided.'}

Timeline Events:
${aggregatedContext.timeline && aggregatedContext.timeline.length > 0 
    ? aggregatedContext.timeline.slice(0, 10).map((event, idx) => {
        const eventDate = event.date || event.start?.dateTime || 'Date unknown';
        const type = event.type || 'event';
        const title = event.title || event.summary || 'Untitled';
        return `${idx + 1}. [${eventDate}] ${type}: ${title}`;
      }).join('\n')
    : 'No timeline events available.'}`;

            // Replace placeholders in structure
            let fullPrompt = promptStructure
                .replace(/\[ATTENDEE_NAMES\]/g, allAttendeeNames.join(', '))
                .replace(/\[DATE\]/g, date)
                .replace(/\[USER_NAME\]/g, userName)
                .replace(/\[USER_EMAIL\]/g, userEmail)
                .replace(/\[NARRATIVE\]/g, narrative)
                .replace(/\[ATTENDEE_DETAILS_SECTION\]/g, attendeeDetailsSection)
                .replace(/\[MEETING_BRIEFS_SECTION\]/g, meetingBriefsSection)
                .replace(/\[AGGREGATED_CONTEXT_SECTION\]/g, aggregatedContextSection);

            // If placeholders weren't used, append sections at the end
            if (!promptStructure.includes('[ATTENDEE_DETAILS_SECTION]')) {
                fullPrompt += attendeeDetailsSection;
            }
            if (!promptStructure.includes('[MEETING_BRIEFS_SECTION]')) {
                fullPrompt += '\n\n' + meetingBriefsSection;
            }
            if (!promptStructure.includes('[AGGREGATED_CONTEXT_SECTION]')) {
                fullPrompt += '\n\n' + aggregatedContextSection;
            }

            // Add transcription hints if not already included
            const transcriptionHints = `\n\n=== TRANSCRIPTION ACCURACY HINTS ===
When transcribing user speech, pay special attention to these names: ${allAttendeeNames.join(', ')}. These are meeting attendees and should be transcribed accurately.`;

            if (!fullPrompt.includes('transcription') && !fullPrompt.includes('Transcription')) {
                fullPrompt += transcriptionHints;
            }

            return fullPrompt;
        } catch (error) {
            logger.error('Failed to generate dynamic day prep prompt, using fallback', error);
            return this.buildDayPrepFallbackPrompt({
                userName,
                userEmail,
                date,
                narrative,
                meetings,
                aggregatedAttendees,
                aggregatedContext,
                attendeeNames: allAttendeeNames
            });
        }
    }

    /**
     * Generate day prep prompt structure using GPT
     */
    async generateDayPrepPromptStructure(context) {
        const systemPromptForGPT = `You are an expert at creating system prompts for voice AI assistants. Generate a well-structured system prompt framework for Shadow's day prep mode.

The prompt structure should:
1. Include transcription hints section (with placeholder for attendee names)
2. Include Shadow's role and persona for day prep
3. Include briefing instructions (5-7 minutes, 750-1000 words, concise, Shadow's style)
4. Include interruption handling rules
5. Include response format requirements
6. Include Q&A capabilities for answering questions about meetings and attendees
7. Be well-structured and comprehensive

Format: Return ONLY the system prompt structure text with placeholders like [ATTENDEE_NAMES], [DATE], [USER_NAME], [NARRATIVE], etc. No markdown, no explanations.`;

        const userPrompt = `Generate a system prompt structure for Shadow's day prep mode briefing ${context.userName} about their day.

DAY OVERVIEW:
- Date: [DATE]
- Meeting Count: ${context.meetingCount}
- Attendee Count: ${context.attendeeCount}
- Attendee Names: ${context.attendeeNames.join(', ')}

The structure should include placeholders for:
- [ATTENDEE_NAMES] - list of all attendee names for transcription hints
- [DATE] - the date string
- [USER_NAME] - user's name
- [USER_EMAIL] - user's email
- [NARRATIVE] - the synthesized day prep narrative
- [ATTENDEE_DETAILS_SECTION] - comprehensive attendee information section
- [MEETING_BRIEFS_SECTION] - all individual meeting briefs
- [AGGREGATED_CONTEXT_SECTION] - aggregated context from all meetings

Generate a comprehensive system prompt structure for Shadow's day prep mode that enables answering questions about specific meetings and attendees.`;

        const response = await this.fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.openaiApiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-5',
                temperature: 0.7,
                messages: [
                    { role: 'system', content: systemPromptForGPT },
                    { role: 'user', content: userPrompt }
                ],
                max_completion_tokens: 4000
            })
        });

        if (!response.ok) {
            throw new Error(`GPT API error: ${response.status}`);
        }

        const data = await response.json();
        return data.choices[0].message.content.trim();
    }

    /**
     * Fallback day prep prompt if GPT generation fails
     */
    buildDayPrepFallbackPrompt(context) {
        const transcriptionHints = context.attendeeNames.length > 0 
            ? `\n\nTRANSCRIPTION ACCURACY HINTS:\nWhen transcribing user speech, pay special attention to these names: ${context.attendeeNames.join(', ')}. These are meeting attendees and should be transcribed accurately.\n`
            : '';

        // Build comprehensive attendee details
        const attendeeDetails = context.aggregatedAttendees.length > 0
            ? context.aggregatedAttendees.map(att => {
                const name = att.name || 'Unknown attendee';
                const email = att.email || 'No email';
                const title = att.title || 'Role unknown';
                const company = att.company || 'Company unknown';
                const keyFacts = att.keyFacts && att.keyFacts.length > 0 
                    ? att.keyFacts.join('\n    • ') 
                    : 'Limited context available';
                
                return `  ${name} (${email})
    Role: ${title}
    Company: ${company}
    Key Facts:
    • ${keyFacts}`;
            }).join('\n\n')
            : '  No attendee information available.';

        // Build individual meeting briefs
        const meetingBriefs = context.meetings.length > 0
            ? context.meetings.map((brief, idx) => {
                const meetingTitle = brief.summary || brief.title || `Meeting ${idx + 1}`;
                const meetingTime = brief.start?.dateTime || brief.start?.date || 'Time TBD';
                const briefAttendees = brief.attendees || [];
                
                return `Meeting ${idx + 1}: ${meetingTitle}
Time: ${meetingTime}
Attendees: ${briefAttendees.map(a => `${a.name || 'Unknown'}${a.company ? ` (${a.company})` : ''}`).join(', ')}
Summary: ${brief.summary || 'No summary available.'}
Recommendations: ${brief.recommendations && brief.recommendations.length > 0 ? brief.recommendations.join('; ') : 'None'}
Action Items: ${brief.actionItems && brief.actionItems.length > 0 ? brief.actionItems.join('; ') : 'None'}`;
            }).join('\n\n---\n\n')
            : 'No individual meeting briefs available.';

        // Build aggregated context
        const aggregatedContext = `Relationship Analysis: ${context.aggregatedContext.relationshipAnalysis || 'No relationship analysis.'}
Email Context: ${context.aggregatedContext.emailAnalysis || 'No email context.'}
Document Context: ${context.aggregatedContext.documentAnalysis || 'No document context.'}
Company Research: ${context.aggregatedContext.companyResearch || 'No company research.'}
Recommendations: ${context.aggregatedContext.recommendations && context.aggregatedContext.recommendations.length > 0 
    ? context.aggregatedContext.recommendations.join('; ') 
    : 'None'}`;

        return `You are Shadow, ${context.userName}'s hyper-contextual executive assistant. Deliver a precise, calm, powerful day prep brief.

IMPORTANT: You are briefing ${context.userName} (${context.userEmail}) about their day on ${context.date}. Use "you" to refer to ${context.userName}. Structure everything from ${context.userName}'s perspective.

RULES:
- You have a synthesized day prep narrative that you should deliver naturally
- You can answer questions about specific meetings and attendees
- Maximum 5-7 minutes for initial brief (~750-1000 words)
- Start fast, no fluff, no preamble
- Every sentence must add value - cut any filler
- Prioritize only what changes decisions or behavior
- Simple, high-clarity language
- Voice style: Calm, confident Chief of Staff whispering the essentials

=== DAY PREP NARRATIVE ===
${context.narrative}

=== ATTENDEE INFORMATION ===
${attendeeDetails}

=== INDIVIDUAL MEETING BRIEFS ===
${meetingBriefs}

=== AGGREGATED CONTEXT ===
${aggregatedContext}
${transcriptionHints}

INTERRUPTION RULES (CRITICAL):
- When user interrupts: STOP IMMEDIATELY
- Answer their question directly using meeting context (<15 seconds)
- Then RESUME from the EXACT sentence you left off
- NO meta-phrases: NEVER say "Let me pause", "As I was saying", "Do you want me to resume", "Should I continue", "Where was I"
- Resume naturally with NO repetition, NO restarting, NO explanations

RESPONSE FORMAT:
- Output ONLY the speech text
- NO markdown, NO formatting, NO stage directions
- Speak as Shadow: calm, confident, concise
- When answering questions about attendees, use their full key facts and context
- When answering questions about meetings, use the individual meeting briefs above
- Every word counts - be ruthless about brevity

CRITICAL: You have access to comprehensive attendee information and individual meeting briefs above. When answering questions about attendees ("Who is X?"), provide detailed information from the attendee information section. When answering questions about meetings ("Tell me about meeting Y"), use the individual meeting briefs section.`;
    }
}

module.exports = VoicePrepManager;
