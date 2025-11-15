/**
 * Voice Prep Briefing Service - 2-Minute Meeting Preparation
 *
 * Architecture: Deepgram (STT) + GPT-4o (LLM) + OpenAI TTS
 *
 * Features:
 * - Structured 2-minute briefing (intro → attendees → insights → agenda → recommendations → Q&A)
 * - Natural interruption handling with context preservation
 * - Section-based pacing with visual indicators
 * - Conversational style optimized for quick comprehension
 */

const { createClient } = require('@deepgram/sdk');
const fetch = require('node-fetch');

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
    constructor(meetingBrief, openaiApiKey) {
        this.brief = meetingBrief;
        this.openaiApiKey = openaiApiKey;

        // State management
        this.state = States.INITIALIZING;
        this.currentSection = null;
        this.sectionStartTime = null;
        this.briefingStartTime = null;
        this.elapsedTime = 0;

        // Deepgram connection
        this.deepgram = createClient(process.env.DEEPGRAM_API_KEY);
        this.deepgramConnection = null;

        // WebSocket reference
        this.ws = null;

        // Conversation history
        this.conversationHistory = [];
        this.briefingDelivered = false;

        // Abort controller for GPT requests
        this.abortController = null;

        // Timer for section transitions
        this.sectionTimer = null;
        this.elapsedTimer = null;
    }

    /**
     * Initialize voice prep briefing
     */
    async connect(ws) {
        this.ws = ws;
        this.briefingStartTime = Date.now();

        // Initialize Deepgram for speech recognition
        this.deepgramConnection = this.deepgram.listen.live({
            model: 'nova-2',
            language: 'en',
            encoding: 'linear16',
            sample_rate: 16000,
            channels: 1,
            smart_format: true,
            punctuate: true,
            interim_results: true,
            utterance_end_ms: 1500,
            vad_events: true,
            endpointing: 500
        });

        this.setupDeepgramEvents();

        console.log('🎤 Voice Prep Briefing initialized');

        // Send ready message
        this.sendToClient({
            type: 'voice_prep_ready',
            message: 'Starting your 2-minute briefing...'
        });

        // Start the elapsed time tracker
        this.startElapsedTimer();

        // Begin the structured briefing
        await this.startBriefing();
    }

    /**
     * Set up Deepgram event handlers
     */
    setupDeepgramEvents() {
        this.deepgramConnection.on('open', () => {
            console.log('🎤 Deepgram connection opened for voice prep');
        });

        this.deepgramConnection.on('Transcript', async (data) => {
            const transcript = data.channel?.alternatives?.[0];
            if (!transcript || !transcript.transcript) return;

            const text = transcript.transcript;
            const isFinal = data.is_final;
            const speechFinal = data.speech_final;

            // Send transcript to client
            this.sendToClient({
                type: 'voice_prep_transcript',
                text: text,
                isFinal: isFinal,
                speaker: 'You'
            });

            // Handle speech_final (user finished speaking)
            if (speechFinal && text.trim()) {
                console.log(`💬 User question: "${text}"`);

                // User interrupted or asked a question
                if (this.state === States.BRIEFING) {
                    console.log('⚠️  User interrupted briefing');
                    this.handleInterruption();
                }

                // Process the user's question
                await this.handleUserQuestion(text);
            }
        });

        this.deepgramConnection.on('SpeechStarted', () => {
            // User started speaking - prepare to interrupt if needed
            if (this.state === States.BRIEFING) {
                this.handleInterruption();
            }
        });

        this.deepgramConnection.on('error', (error) => {
            console.error('Deepgram error:', error);
            this.sendToClient({
                type: 'error',
                message: 'Voice recognition error'
            });
        });

        this.deepgramConnection.on('close', () => {
            console.log('🎤 Deepgram connection closed');
        });
    }

    /**
     * Start the structured 2-minute briefing
     */
    async startBriefing() {
        this.state = States.BRIEFING;
        this.briefingDelivered = false;

        // Build comprehensive system prompt for structured briefing
        const systemPrompt = this.buildBriefingPrompt();

        // Add to conversation history
        this.conversationHistory.push({
            role: 'system',
            content: systemPrompt
        });

        this.conversationHistory.push({
            role: 'user',
            content: 'Please begin the 2-minute briefing now.'
        });

        // Generate the briefing
        await this.generateAndSpeakResponse();
    }

    /**
     * Build the comprehensive briefing prompt
     */
    buildBriefingPrompt() {
        const meeting = this.brief;

        return `You are conducting a 2-minute voice briefing to prepare someone for an upcoming meeting.

MEETING DETAILS:
Title: ${meeting.summary || 'Upcoming Meeting'}
Time: ${meeting.start?.dateTime || meeting.start?.date || 'Not specified'}
Attendees: ${meeting.attendees?.map(a => a.name).join(', ') || 'Not specified'}

YOUR 2-MINUTE BRIEFING STRUCTURE:

SECTION 1 - INTRODUCTION (10 seconds):
"Let me brief you on your upcoming meeting: ${meeting.summary}. Over the next 2 minutes, I'll cover who's attending, key insights from your past interactions, and what you need to know to be fully prepared."

SECTION 2 - ATTENDEES (40 seconds):
${meeting.attendees?.map(att => `
**${att.name}** (${att.title || 'Role not specified'}, ${att.company || 'Company not specified'}):
${att.keyFacts?.slice(0, 2).join('. ') || 'No specific context available.'}`).join('\n\n') || 'Attendee information not available.'}

SECTION 3 - KEY INSIGHTS (30 seconds):
Email Context: ${meeting.emailAnalysis?.substring(0, 400) || 'No recent email history found.'}

Document Context: ${meeting.documentAnalysis?.substring(0, 400) || 'No shared documents analyzed.'}

Working Relationships: ${meeting.relationshipAnalysis?.substring(0, 400) || 'No prior working relationship detected.'}

SECTION 4 - MEETING AGENDA & PURPOSE (20 seconds):
${meeting.summary || 'Meeting purpose not specified. Based on available context, this appears to be a general sync or discussion meeting.'}

${meeting.context || ''}

SECTION 5 - RECOMMENDATIONS (15 seconds):
Top preparation tips:
${meeting.recommendations?.slice(0, 3).map((rec, i) => `${i + 1}. ${rec}`).join('\n') || 'No specific recommendations generated yet.'}

SECTION 6 - TRANSITION TO Q&A:
"That's your 2-minute briefing. I'm now ready to answer any questions you have about the meeting, the attendees, or the context."

DELIVERY GUIDELINES:
- Speak conversationally and naturally (like a colleague briefing you)
- Pace: ~150 words per minute (brisk but not rushed)
- Be specific: Use actual names, dates, document titles from the context
- Stay focused: This is a quick prep, not a lecture
- Smooth transitions: "Now let's talk about..." or "Moving to..."
- If interrupted, STOP IMMEDIATELY and answer the question, then ask: "Should I continue the briefing or answer more questions?"

INTERRUPTION HANDLING:
- User can interrupt at ANY time by speaking
- When interrupted, STOP the current section
- Answer their question directly and concisely
- Then ask: "Would you like me to continue the briefing, or do you have more questions?"
- Resume from where you left off or pivot to Q&A based on their response

AFTER 2 MINUTES:
- Switch to open Q&A mode
- Say: "That's your briefing complete. What questions do you have?"
- Answer questions about any aspect of the meeting context
- Be conversational and helpful

RESPONSE FORMAT:
- Output ONLY the speech text you want to say
- NO markdown, NO formatting, NO stage directions
- Just natural, conversational speech`;
    }

    /**
     * Handle user interruption during briefing
     */
    handleInterruption() {
        // Cancel any ongoing TTS or GPT requests
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        // Update state
        this.state = States.INTERRUPTED;

        // Send interruption notification to client
        this.sendToClient({
            type: 'voice_prep_interrupted',
            message: 'Paused for your question'
        });

        console.log('🔄 Briefing interrupted, listening for question');
    }

    /**
     * Handle user's question (during briefing or Q&A)
     */
    async handleUserQuestion(question) {
        // Add user question to history
        this.conversationHistory.push({
            role: 'user',
            content: question
        });

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

        // Generate response
        await this.generateAndSpeakResponse();
    }

    /**
     * Generate AI response and speak it via TTS
     */
    async generateAndSpeakResponse() {
        // Create abort controller
        this.abortController = new AbortController();

        try {
            // Call GPT-4o
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o',
                    messages: this.conversationHistory,
                    temperature: 0.7,
                    max_tokens: 400 // Keep responses concise for voice
                }),
                signal: this.abortController.signal
            });

            if (!response.ok) {
                throw new Error(`GPT API error: ${response.status}`);
            }

            const data = await response.json();
            const aiResponse = data.choices[0].message.content;

            // Add to conversation history
            this.conversationHistory.push({
                role: 'assistant',
                content: aiResponse
            });

            // Send AI response to client for TTS
            this.sendToClient({
                type: 'voice_prep_response',
                text: aiResponse,
                speaker: 'AI'
            });

            // Also request TTS generation from OpenAI
            await this.generateTTS(aiResponse);

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('GPT request aborted (interrupted)');
                return;
            }

            console.error('Error generating response:', error);
            this.sendToClient({
                type: 'error',
                message: 'Failed to generate response'
            });
        }
    }

    /**
     * Generate TTS audio for AI response
     */
    async generateTTS(text) {
        try {
            const response = await fetch('https://api.openai.com/v1/audio/speech', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'tts-1',
                    voice: 'nova',
                    input: text,
                    speed: 1.1 // Slightly faster for briefing
                })
            });

            if (!response.ok) {
                throw new Error(`TTS API error: ${response.status}`);
            }

            const audioBuffer = await response.arrayBuffer();

            // Send audio to client
            this.sendToClient({
                type: 'voice_prep_audio',
                audio: Buffer.from(audioBuffer).toString('base64')
            });

        } catch (error) {
            console.error('TTS generation error:', error);
        }
    }

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
     * Send audio data to Deepgram
     */
    sendAudio(audioData) {
        if (this.deepgramConnection && this.deepgramConnection.getReadyState() === 1) {
            this.deepgramConnection.send(audioData);
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
        console.log('Disconnecting voice prep briefing');

        // Clear timers
        if (this.sectionTimer) {
            clearTimeout(this.sectionTimer);
            this.sectionTimer = null;
        }

        if (this.elapsedTimer) {
            clearInterval(this.elapsedTimer);
            this.elapsedTimer = null;
        }

        // Cancel any pending requests
        if (this.abortController) {
            this.abortController.abort();
        }

        // Close Deepgram connection
        if (this.deepgramConnection) {
            try {
                this.deepgramConnection.finish();
            } catch (error) {
                console.error('Error closing Deepgram:', error);
            }
            this.deepgramConnection = null;
        }

        // Update state
        this.state = States.ENDED;
        this.conversationHistory = [];
    }
}

module.exports = VoicePrepManager;
