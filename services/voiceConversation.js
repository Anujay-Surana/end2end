/**
 * Voice Conversation Service for Interactive Meeting Prep
 *
 * Architecture: Deepgram Flux (STT) + GPT-4o (LLM + Function Calling) + Web Speech API (TTS)
 *
 * Features:
 * - Real-time speech-to-text with turn detection
 * - GPT-4o with Parallel AI web search integration
 * - Natural conversation with interruption handling
 * - State machine for turn-taking
 */

const { createClient } = require('@deepgram/sdk');
const fetch = require('node-fetch');

// Conversation states
const States = {
    LISTENING: 'listening',
    PROCESSING: 'processing',
    SPEAKING: 'speaking',
    INTERRUPTED: 'interrupted'
};

class VoiceConversationManager {
    constructor(meetingContext, userEmail, parallelClient, openaiApiKey) {
        this.meetingContext = meetingContext;
        this.userEmail = userEmail;
        this.parallelClient = parallelClient;
        this.openaiApiKey = openaiApiKey;

        // State management
        this.state = States.LISTENING;
        this.deepgramConnection = null;
        this.transcriptBuffer = [];
        this.conversationHistory = [];
        this.currentUtterance = '';

        // WebSocket reference
        this.ws = null;

        // Abort controller for cancelling GPT requests
        this.abortController = null;

        // Deepgram client
        this.deepgram = createClient(process.env.DEEPGRAM_API_KEY);
    }

    /**
     * Initialize voice conversation
     */
    async connect(ws) {
        this.ws = ws;

        // Initialize Deepgram with optimized configuration for conversations
        this.deepgramConnection = this.deepgram.listen.live({
            model: 'nova-2',
            language: 'en',
            encoding: 'linear16',
            sample_rate: 16000,
            channels: 1,

            // Formatting & Quality
            smart_format: true,
            punctuate: true,
            filler_words: true,          // Remove um, uh, etc. for cleaner transcripts
            numerals: true,              // Convert numbers to digits

            // Streaming & Timing (optimized for conversations)
            interim_results: true,
            utterance_end_ms: 1000,      // Optimized from 1500ms for faster turn detection
            endpointing: 300,            // Reduced from 500ms for more responsive conversations

            // Voice Activity Detection
            vad_events: true,            // Enabled for better interruption handling

            // Performance Optimization
            diarize: false,              // Single speaker optimization
            multichannel: false,

            // Keywords (optional - boost recognition for meeting-related terms)
            keywords: ['meeting:2', 'attendees:2', 'agenda:2', 'brief:2']
        });

        // Set up event handlers
        this.setupDeepgramEvents();

        console.log('✅ Voice conversation initialized');

        // Send ready message
        this.sendToClient({
            type: 'voice_ready',
            message: 'Voice conversation ready. Start speaking!'
        });
    }

    /**
     * Set up Deepgram event handlers
     */
    setupDeepgramEvents() {
        this.deepgramConnection.on('open', () => {
            console.log('🎤 Deepgram connection opened');
        });

        this.deepgramConnection.on('Results', async (data) => {
            const transcript = data.channel?.alternatives?.[0];
            if (!transcript || !transcript.transcript) return;

            const text = transcript.transcript;
            const isFinal = data.is_final;
            const speechFinal = data.speech_final;

            // Send transcript to client
            this.sendToClient({
                type: 'voice_transcript',
                text: text,
                isFinal: isFinal,
                speaker: 'You'
            });

            // Handle speech_final (end of utterance)
            if (speechFinal && text.trim()) {
                console.log(`💬 User utterance complete: "${text}"`);

                // Check if we should interrupt
                if (this.state === States.SPEAKING) {
                    console.log('⚠️  User interrupted AI - cancelling response');
                    this.handleInterruption();
                }

                // Add to buffer
                this.transcriptBuffer.push({
                    speaker: 'user',
                    text: text,
                    timestamp: Date.now()
                });

                // Limit buffer size
                if (this.transcriptBuffer.length > 30) {
                    this.transcriptBuffer = this.transcriptBuffer.slice(-30);
                }

                // Process the utterance
                await this.processUserUtterance(text);
            }
        });

        // Voice Activity Detection events
        this.deepgramConnection.on('SpeechStarted', () => {
            console.log('🎤 Speech started');

            // If AI is speaking, interrupt it
            if (this.state === States.SPEAKING) {
                this.handleInterruption();
            }
        });

        this.deepgramConnection.on('UtteranceEnd', () => {
            console.log('🎤 Utterance end detected');
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
     * Handle user interruption during AI speech
     */
    handleInterruption() {
        // Cancel any pending GPT request
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        // Notify client to stop TTS playback
        this.sendToClient({
            type: 'stop_tts',
            message: 'Interrupted by user'
        });

        // Switch back to listening state
        this.state = States.LISTENING;

        console.log('🔄 Switched to listening after interruption');
    }

    /**
     * Process user utterance with GPT-4o
     */
    async processUserUtterance(text) {
        if (!text.trim()) return;

        // Update state
        this.state = States.PROCESSING;
        this.sendToClient({
            type: 'state_change',
            state: States.PROCESSING
        });

        // Add to conversation history
        this.conversationHistory.push({
            role: 'user',
            content: text
        });

        try {
            // Create abort controller for cancellation
            this.abortController = new AbortController();

            // Build system prompt with meeting context
            const systemPrompt = this.buildSystemPrompt();

            // Build messages array
            const messages = [
                { role: 'system', content: systemPrompt },
                ...this.conversationHistory
            ];

            // Define web search tool
            const tools = [{
                type: 'function',
                function: {
                    name: 'web_search',
                    description: 'Search the web for additional information about meeting attendees, companies, or topics when the meeting context is insufficient',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Specific search query for additional information'
                            }
                        },
                        required: ['query']
                    }
                }
            }];

            // Call GPT-4o
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-5',
                    messages: messages,
                    tools: tools,
                    tool_choice: 'auto',
                    temperature: 0.7,
                    max_tokens: 300 // Keep responses concise for voice
                }),
                signal: this.abortController.signal
            });

            if (!response.ok) {
                throw new Error(`GPT API error: ${response.status}`);
            }

            const data = await response.json();
            const assistantMessage = data.choices[0].message;

            // Check if tool call was made
            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                const toolCall = assistantMessage.tool_calls[0];

                if (toolCall.function.name === 'web_search') {
                    const args = JSON.parse(toolCall.function.arguments);
                    console.log(`🔍 Web search requested: ${args.query}`);

                    // Notify client about search
                    this.sendToClient({
                        type: 'function_call',
                        function: 'web_search',
                        query: args.query
                    });

                    // Execute web search
                    const searchResult = await this.executeWebSearch(args.query);

                    // Second GPT call with search results
                    const finalMessages = [
                        ...messages,
                        assistantMessage,
                        {
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: searchResult
                        }
                    ];

                    const finalResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${this.openaiApiKey}`
                        },
                        body: JSON.stringify({
                            model: 'gpt-5',
                            messages: finalMessages,
                            max_completion_tokens: 300
                        }),
                        signal: this.abortController.signal
                    });

                    const finalData = await finalResponse.json();
                    const finalMessage = finalData.choices[0].message.content;

                    await this.speakResponse(finalMessage);
                    return;
                }
            }

            // No tool call, speak direct response
            if (assistantMessage.content) {
                await this.speakResponse(assistantMessage.content);
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('GPT request aborted (interrupted)');
                return;
            }

            console.error('Error processing utterance:', error);
            this.sendToClient({
                type: 'error',
                message: 'Failed to process your message'
            });

            // Reset to listening
            this.state = States.LISTENING;
            this.sendToClient({
                type: 'state_change',
                state: States.LISTENING
            });
        }
    }

    /**
     * Execute web search using Parallel AI
     */
    async executeWebSearch(query) {
        try {
            const searchResult = await this.parallelClient.beta.search({
                objective: query,
                search_queries: [query],
                mode: 'one-shot',
                max_results: 5,
                max_chars_per_result: 2000
            });

            if (searchResult.results && searchResult.results.length > 0) {
                // Synthesize results
                const resultsText = searchResult.results
                    .map((r, i) => `Result ${i + 1}: ${r.title}\n${r.snippet || r.content?.substring(0, 300)}`)
                    .join('\n\n');

                return `Web search results for "${query}":\n\n${resultsText.substring(0, 2000)}`;
            } else {
                return 'No relevant web results found.';
            }
        } catch (error) {
            console.error('Web search error:', error);
            return 'Web search failed.';
        }
    }

    /**
     * Speak AI response using TTS
     */
    async speakResponse(text) {
        console.log(`🤖 AI response: ${text}`);

        // Update state
        this.state = States.SPEAKING;
        this.sendToClient({
            type: 'state_change',
            state: States.SPEAKING
        });

        // Add to conversation history
        this.conversationHistory.push({
            role: 'assistant',
            content: text
        });

        // Add to transcript buffer
        this.transcriptBuffer.push({
            speaker: 'assistant',
            text: text,
            timestamp: Date.now()
        });

        // Send response to client for TTS
        this.sendToClient({
            type: 'ai_response',
            text: text
        });

        // Estimate speech duration (rough: 150 words per minute)
        const words = text.split(/\s+/).length;
        const durationMs = (words / 150) * 60 * 1000;

        // After estimated duration, switch back to listening
        setTimeout(() => {
            if (this.state === States.SPEAKING) {
                this.state = States.LISTENING;
                this.sendToClient({
                    type: 'state_change',
                    state: States.LISTENING
                });
            }
        }, durationMs + 500); // Add 500ms buffer
    }

    /**
     * Build system prompt with meeting context
     */
    buildSystemPrompt() {
        const meeting = this.meetingContext.meeting || {};
        const attendees = this.meetingContext.attendees || [];

        return `You are an AI meeting preparation assistant having a natural voice conversation with the user.

Meeting Details:
- Title: ${meeting.summary || 'Unknown'}
- Time: ${meeting.start ? new Date(meeting.start.dateTime || meeting.start.date).toLocaleString() : 'Unknown'}
- Attendees: ${attendees.map(a => a.name).join(', ')}

Meeting Context:
${JSON.stringify({
    summary: this.meetingContext.summary,
    emailAnalysis: this.meetingContext.emailAnalysis?.substring(0, 500),
    documentAnalysis: this.meetingContext.documentAnalysis?.substring(0, 500),
    recommendations: this.meetingContext.recommendations?.slice(0, 3)
}, null, 2).substring(0, 3000)}

Your Role:
- Help the user prepare for this meeting through natural conversation
- Answer questions about attendees, agenda, context, and documents
- Provide actionable preparation tips
- Use web_search function when you need additional information not in the meeting context

Voice Conversation Guidelines:
- Keep responses CONCISE (2-3 sentences max, unless asked for detail)
- Speak naturally and conversationally
- Be direct and helpful
- Ask clarifying questions when needed
- Proactively suggest useful preparation steps
- If asked about something not in the context, use web_search tool

Remember: This is a VOICE conversation, not text chat. Be brief and natural!`;
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
     * Send message to client
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
        console.log('Disconnecting voice conversation');

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

        // Clear state
        this.state = States.LISTENING;
        this.transcriptBuffer = [];
        this.conversationHistory = [];
    }
}

module.exports = VoiceConversationManager;
