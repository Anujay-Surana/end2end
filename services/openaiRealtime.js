/**
 * OpenAI Realtime API Service
 * 
 * Handles WebSocket connection to OpenAI Realtime API for voice-to-voice interactions
 * Features:
 * - Low-latency streaming audio (input/output)
 * - Built-in interruption handling
 * - Session state management
 * - Audio buffer management
 */

const WebSocket = require('ws');
const logger = require('./logger');

class OpenAIRealtimeManager {
    constructor(openaiApiKey, systemPrompt, userContext = null) {
        this.openaiApiKey = openaiApiKey;
        this.systemPrompt = systemPrompt;
        this.userContext = userContext;
        
        // WebSocket connection
        this.ws = null;
        this.realtimeWs = null; // Connection to OpenAI Realtime API
        
        // State management
        this.isConnected = false;
        this.isSpeaking = false;
        this.isListening = false;
        this.sessionId = null;
        this.isCancelling = false; // Track if cancellation is in progress
        this.currentResponseId = null; // Track current response ID
        this.cancelledResponseId = null; // Track response ID being cancelled to filter audio chunks
        
        // Audio buffers
        this.inputAudioBuffer = [];
        this.outputAudioBuffer = [];
        
        // Audio buffer tracking for commit logic
        // Note: With server_vad, OpenAI automatically commits buffers, so we only track for manual commits
        this.accumulatedAudioBytes = 0; // Track total bytes accumulated
        this.hasSentAudio = false; // Track if any audio has been sent in this session
        this.lastCommitTime = 0; // Track when we last attempted a commit (to prevent rapid repeated commits)
        this.sampleRate = 16000; // 16kHz for PCM16
        this.bytesPerSample = 2; // 16-bit = 2 bytes per sample
        this.minCommitBytes = 3200; // 100ms at 16kHz = 1600 samples = 3200 bytes
        this.usingServerVAD = true; // We're using server_vad, so OpenAI handles commits automatically
        
        // Event handlers
        this.onTranscript = null;
        this.onAudioChunk = null;
        this.onError = null;
        this.onDisconnect = null;
        this.onSpeechStarted = null; // Callback when user starts speaking
        this.onSpeechStopped = null; // Callback when user stops speaking
        
        // Conversation state
        this.conversationHistory = [];
        this.currentTranscript = '';
        
        // Interruption handling
        this.interrupted = false;
        this.resumePosition = null;
    }

    /**
     * Connect to OpenAI Realtime API
     */
    async connect(clientWs) {
        this.ws = clientWs;
        
        try {
            // Create WebSocket connection to OpenAI Realtime API
            const wsUrl = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
            
            this.realtimeWs = new WebSocket(wsUrl, {
                headers: {
                    'Authorization': `Bearer ${this.openaiApiKey}`,
                    'OpenAI-Beta': 'realtime=v1'
                }
            });

            this.setupRealtimeEvents();
            
            // Wait for connection
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Connection timeout'));
                }, 10000);
                
                this.realtimeWs.on('open', () => {
                    clearTimeout(timeout);
                    this.isConnected = true;
                    logger.info('Connected to OpenAI Realtime API');
                    resolve();
                });
                
                this.realtimeWs.on('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });

            // Initialize session
            await this.initializeSession();
            
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to connect to OpenAI Realtime API');
            throw error;
        }
    }

    /**
     * Set up event handlers for Realtime API WebSocket
     */
    setupRealtimeEvents() {
        this.realtimeWs.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                this.handleRealtimeMessage(message);
            } catch (error) {
                logger.error({ error: error.message }, 'Failed to parse Realtime API message');
            }
        });

        this.realtimeWs.on('error', (error) => {
            logger.error({ error: error.message }, 'Realtime API WebSocket error');
            if (this.onError) {
                this.onError(error);
            }
        });

        this.realtimeWs.on('close', () => {
            logger.info('Realtime API WebSocket closed');
            this.isConnected = false;
            if (this.onDisconnect) {
                this.onDisconnect();
            }
        });
    }

    /**
     * Handle messages from Realtime API
     */
    handleRealtimeMessage(message) {
        const { type, event } = message;

        switch (type) {
            case 'session.created':
                this.sessionId = message.session.id;
                logger.info({ sessionId: this.sessionId }, 'Realtime session created');
                this.sendToClient({
                    type: 'realtime_ready',
                    message: 'Realtime API ready'
                });
                break;

            case 'session.updated':
                logger.info('Realtime session updated');
                // Session is now fully initialized and ready to accept messages
                this.sendToClient({
                    type: 'realtime_session_ready',
                    message: 'Session ready'
                });
                break;

            case 'conversation.item.created':
                logger.info({ itemId: message.item?.id }, 'Conversation item created');
                break;

            case 'input_audio_buffer.speech_started':
                // User started speaking - this is detected by server_vad
                logger.info('🎤 User speech started (VAD detected)');
                // Explicitly cancel any ongoing response when user speaks
                // CRITICAL: Cancel immediately before processing user input
                if (this.isSpeaking && !this.isCancelling) {
                    logger.info('⚠️ User interrupting AI - cancelling response immediately');
                    this.cancelResponse();
                }
                // Update speaking state for UI feedback
                this.isSpeaking = false;
                // Notify handler for UI updates
                if (this.onSpeechStarted) {
                    this.onSpeechStarted();
                }
                break;

            case 'input_audio_buffer.speech_stopped':
                // User stopped speaking
                logger.info('🎤 User speech stopped (VAD detected)');
                // Notify handler
                if (this.onSpeechStopped) {
                    this.onSpeechStopped();
                }
                break;

            case 'conversation.item.input_audio_transcription.delta':
                // Partial transcription
                logger.info('Received input audio transcription delta', { delta: message.delta });
                if (message.delta) {
                    this.currentTranscript += message.delta;
                    if (this.onTranscript) {
                        this.onTranscript({
                            text: this.currentTranscript,
                            isFinal: false
                        });
                    }
                }
                break;

            case 'conversation.item.input_audio_transcription.completed':
                // Final transcription - OpenAI has committed the buffer internally (via server_vad)
                // Use message.transcript if available (more reliable), otherwise use accumulated currentTranscript
                const finalTranscript = (message.transcript && message.transcript.trim()) 
                    ? message.transcript.trim() 
                    : (this.currentTranscript && this.currentTranscript.trim() 
                        ? this.currentTranscript.trim() 
                        : '');
                
                logger.info('Received input audio transcription completed', { 
                    transcript: finalTranscript,
                    fromMessage: !!message.transcript,
                    fromAccumulated: !!this.currentTranscript
                });
                
                // Clear accumulated transcript
                this.currentTranscript = '';
                
                // Reset accumulated bytes when OpenAI commits internally (via server_vad)
                // This happens when OpenAI detects speech end and commits the buffer
                // We reset to prevent trying to commit again manually
                this.accumulatedAudioBytes = 0;
                this.lastCommitTime = Date.now(); // Update last commit time to prevent rapid re-commits
                
                // Only process if we have a valid transcript
                if (finalTranscript && this.onTranscript) {
                    this.onTranscript({
                        text: finalTranscript,
                        isFinal: true
                    });
                    
                    // Add to conversation history (avoid duplicates)
                    const lastMessage = this.conversationHistory[this.conversationHistory.length - 1];
                    if (!lastMessage || lastMessage.content !== finalTranscript) {
                        this.conversationHistory.push({
                            role: 'user',
                            content: finalTranscript
                        });
                    }
                }
                break;

            case 'conversation.item.output_audio.delta':
                // Audio chunk from AI (from conversation item)
                if (message.delta) {
                    const responseId = message.response_id || this.currentResponseId;
                    
                    // Filter out audio chunks from cancelled responses
                    if (this.isCancelling || this.cancelledResponseId === responseId) {
                        logger.debug('Skipping audio chunk from cancelled response', { responseId });
                        return;
                    }
                    
                    this.isSpeaking = true;
                    this.currentResponseId = responseId;
                    logger.debug('Received audio delta from conversation item', { responseId: this.currentResponseId });
                    if (this.onAudioChunk) {
                        this.onAudioChunk(message.delta);
                    }
                    // Forward to client
                    this.sendToClient({
                        type: 'realtime_audio',
                        audio: message.delta
                    });
                }
                break;

            case 'conversation.item.output_audio.done':
                // AI finished speaking (from conversation item)
                this.isSpeaking = false;
                this.isCancelling = false;
                this.currentResponseId = null;
                logger.info('Conversation item audio done');
                this.sendToClient({
                    type: 'realtime_audio_done',
                    message: 'AI finished speaking'
                });
                break;

            case 'response.audio_transcript.delta':
                // Audio transcript delta from response
                logger.debug('Received response audio transcript delta');
                break;

            case 'response.audio_transcript.done':
                // Audio transcript done from response
                logger.info('Response audio transcript done');
                break;

            case 'response.audio.delta':
                // Audio chunk from response (this is where audio comes from when using response.create)
                if (message.delta) {
                    const responseId = message.response_id || this.currentResponseId;
                    
                    // Filter out audio chunks from cancelled responses
                    if (this.isCancelling || this.cancelledResponseId === responseId) {
                        logger.debug('Skipping audio chunk from cancelled response', { responseId });
                        return;
                    }
                    
                    this.isSpeaking = true;
                    this.currentResponseId = responseId;
                    logger.debug('Received audio delta from response', { responseId: this.currentResponseId });
                    if (this.onAudioChunk) {
                        this.onAudioChunk(message.delta);
                    }
                    // Forward to client
                    this.sendToClient({
                        type: 'realtime_audio',
                        audio: message.delta
                    });
                }
                break;

            case 'response.audio.done':
                // Audio done from response
                this.isSpeaking = false;
                this.isCancelling = false;
                // Don't clear currentResponseId here - wait for response.done
                logger.info('Response audio done', { responseId: message.response_id });
                this.sendToClient({
                    type: 'realtime_audio_done',
                    message: 'Response audio complete'
                });
                break;

            case 'response.output_item.added':
                // Output item added to response
                logger.info({ itemId: message.item?.id }, 'Response output item added');
                break;

            case 'response.done':
                // Response complete
                this.isSpeaking = false;
                this.isCancelling = false;
                this.currentResponseId = null;
                logger.info('Response done', { responseId: message.response_id });
                this.sendToClient({
                    type: 'realtime_audio_done',
                    message: 'Response complete'
                });
                break;

            case 'response.cancelled':
                // Response was cancelled (either by us or by OpenAI)
                this.isSpeaking = false;
                this.isCancelling = false;
                this.currentResponseId = null;
                this.cancelledResponseId = null; // Clear cancelled response ID
                this.interrupted = true;
                logger.info('✅ Response cancelled successfully', { responseId: message.response_id });
                this.sendToClient({
                    type: 'realtime_response_cancelled',
                    message: 'Response cancelled'
                });
                break;

            case 'conversation.item.output_item.added':
                // AI response text (if available)
                if (message.item?.type === 'message' && message.item?.content) {
                    const content = message.item.content;
                    if (Array.isArray(content)) {
                        const textContent = content.find(c => c.type === 'input_text' || c.type === 'text');
                        if (textContent && textContent.text) {
                            this.conversationHistory.push({
                                role: 'assistant',
                                content: textContent.text
                            });
                        }
                    }
                }
                break;

            case 'error':
                logger.error({ error: message.error }, 'Realtime API error');
                
                // Handle empty buffer commit errors gracefully
                if (message.error?.code === 'input_audio_buffer_commit_empty') {
                    logger.warn('Audio buffer commit failed - buffer was empty, resetting state');
                    this.accumulatedAudioBytes = 0;
                    this.hasSentAudio = false;
                    // Don't propagate this error - it's expected when no audio was sent
                    return;
                }
                
                if (this.onError) {
                    this.onError(new Error(message.error?.message || 'Realtime API error'));
                }
                break;

            default:
                // Log all message types for debugging (including response.*)
                logger.debug({ type, event, message: JSON.stringify(message).substring(0, 200) }, 'Realtime API message');
        }
    }

    /**
     * Initialize Realtime API session
     */
    async initializeSession() {
        const config = {
            type: 'session.update',
            session: {
                modalities: ['text', 'audio'],
                instructions: this.systemPrompt,
                voice: 'alloy', // Options: alloy, echo, fable, onyx, nova, shimmer
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                input_audio_transcription: {
                    model: 'whisper-1'
                },
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.4, // Lower threshold = more sensitive to speech starts (improves transcription accuracy)
                    prefix_padding_ms: 400,
                    silence_duration_ms: 600 // Faster speech end detection (reduced from 800ms)
                },
                temperature: 0.8,
                max_response_output_tokens: 4096
            }
        };

        this.sendRealtimeMessage(config);
        
        // Wait a moment for session to be fully initialized
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    /**
     * Send audio input to Realtime API
     * With server_vad, OpenAI automatically commits buffers, so we just append audio
     */
    sendAudioInput(audioData) {
        if (!this.isConnected || !this.realtimeWs) {
            logger.warn('Cannot send audio: not connected to Realtime API');
            return;
        }

        // Convert audio data to base64 if needed
        let audioBase64;
        let audioBytes = 0;
        
        if (Buffer.isBuffer(audioData)) {
            audioBytes = audioData.length;
            audioBase64 = audioData.toString('base64');
        } else if (typeof audioData === 'string') {
            // If it's already base64, decode to get byte count
            try {
                const decoded = Buffer.from(audioData, 'base64');
                audioBytes = decoded.length;
                audioBase64 = audioData;
            } catch (error) {
                logger.error('Invalid base64 audio data');
                return;
            }
        } else {
            logger.error('Invalid audio data format');
            return;
        }

        // Send audio input to buffer
        const message = {
            type: 'input_audio_buffer.append',
            audio: audioBase64
        };

        this.sendRealtimeMessage(message);
        
        // Mark that we've sent audio
        this.hasSentAudio = true;
        
        // Track accumulated audio for potential manual commits (e.g., on stop)
        this.accumulatedAudioBytes += audioBytes;
        
        // NOTE: With server_vad, OpenAI automatically commits buffers when it detects speech
        // We do NOT manually commit here - OpenAI handles it via server-side VAD
    }

    /**
     * Commit audio buffer (trigger transcription)
     * 
     * IMPORTANT: With server_vad, OpenAI automatically commits buffers when it detects speech.
     * Manual commits are rarely needed and should only be used when:
     * 1. Explicitly requested (e.g., on stop to flush remaining audio)
     * 2. We have sent audio AND have enough buffered (>= 100ms)
     * 
     * However, since server_vad handles commits automatically, manual commits often fail
     * with "buffer too small" because OpenAI has already committed the buffer internally.
     */
    commitAudioBuffer() {
        if (!this.isConnected) return;
        
        // Prevent rapid repeated commits (rate limiting)
        const now = Date.now();
        if (now - this.lastCommitTime < 100) {
            logger.debug('Skipping commit: too soon after last commit attempt');
            return;
        }
        this.lastCommitTime = now;
        
        // With server_vad, OpenAI handles commits automatically
        // Manual commits are usually unnecessary and will fail if OpenAI already committed
        // Only commit if explicitly requested AND we've sent audio
        
        if (!this.hasSentAudio) {
            logger.debug('Skipping commit: no audio sent in this session');
            return;
        }
        
        // Check if we have enough audio to commit (at least 100ms)
        // Note: This check may not be accurate if OpenAI already committed internally
        if (this.accumulatedAudioBytes < this.minCommitBytes) {
            logger.debug({ 
                accumulatedBytes: this.accumulatedAudioBytes, 
                minBytes: this.minCommitBytes 
            }, 'Skipping commit: insufficient audio (server_vad handles commits automatically)');
            return;
        }

        // Attempt manual commit (may fail if OpenAI already committed via server_vad)
        logger.debug('Attempting manual audio buffer commit');
        const message = {
            type: 'input_audio_buffer.commit'
        };

        this.sendRealtimeMessage(message);
        
        // Reset accumulated bytes after commit attempt
        // Note: If commit fails, OpenAI will send an error which we handle gracefully
        this.accumulatedAudioBytes = 0;
    }

    /**
     * Cancel current response (interruption)
     */
    cancelResponse() {
        if (!this.isConnected) {
            logger.warn('Cannot cancel response: not connected');
            return;
        }

        if (!this.isSpeaking && !this.currentResponseId) {
            logger.debug('No active response to cancel');
            return;
        }

        if (this.isCancelling) {
            logger.debug('Cancellation already in progress');
            return;
        }

        logger.info('🛑 Cancelling ongoing AI response', { responseId: this.currentResponseId });
        this.isCancelling = true;
        this.interrupted = true;
        
        // Track the response ID being cancelled to filter audio chunks
        this.cancelledResponseId = this.currentResponseId;
        
        // Send immediate cancellation signal to client so it can stop playback
        // This happens before OpenAI confirms cancellation
        this.sendToClient({
            type: 'realtime_response_cancelled',
            message: 'Response cancelled',
            immediate: true // Flag to indicate this is immediate, not confirmed yet
        });
        
        const message = {
            type: 'response.cancel'
        };

        this.sendRealtimeMessage(message);
        // Don't set isSpeaking to false yet - wait for confirmation
    }

    /**
     * Send text input (alternative to audio)
     */
    sendTextInput(text) {
        if (!this.isConnected) return;

        const message = {
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: text
                    }
                ]
            }
        };

        this.sendRealtimeMessage(message);
    }

    /**
     * Request response from AI
     */
    requestResponse() {
        if (!this.isConnected) {
            logger.warn('Cannot request response: not connected');
            return;
        }

        if (!this.sessionId) {
            logger.warn('Cannot request response: session not created');
            return;
        }

        // If cancelling, wait a bit then retry (but don't block forever)
        if (this.isCancelling) {
            logger.info('Cancellation in progress, waiting before creating response...');
            setTimeout(() => {
                if (!this.isCancelling && !this.isSpeaking) {
                    logger.info('Cancellation complete, creating response now');
                    this.requestResponse();
                } else {
                    logger.warn('Still cancelling or speaking, forcing response creation');
                    // Force clear flags and create response
                    this.isCancelling = false;
                    this.isSpeaking = false;
                    this.currentResponseId = null;
                    this._createResponse();
                }
            }, 500);
            return;
        }

        // If speaking, cancel first then retry
        if (this.isSpeaking) {
            logger.warn('Response already active, cancelling first', { responseId: this.currentResponseId });
            this.cancelResponse();
            setTimeout(() => {
                this.requestResponse();
            }, 300);
            return;
        }

        this._createResponse();
    }

    /**
     * Internal method to actually create the response
     */
    _createResponse() {
        logger.info('Creating response with audio modality');
        const message = {
            type: 'response.create',
            response: {
                modalities: ['text', 'audio']
            }
        };

        this.sendRealtimeMessage(message);
    }

    /**
     * Send message to Realtime API WebSocket
     */
    sendRealtimeMessage(message) {
        if (!this.realtimeWs || this.realtimeWs.readyState !== WebSocket.OPEN) {
            logger.warn('Cannot send message: Realtime API WebSocket not open');
            return;
        }

        try {
            const messageStr = JSON.stringify(message);
            logger.debug({ type: message.type, message: messageStr.substring(0, 200) }, 'Sending message to Realtime API');
            this.realtimeWs.send(messageStr);
        } catch (error) {
            logger.error({ error: error.message }, 'Failed to send message to Realtime API');
        }
    }

    /**
     * Send message to client WebSocket
     */
    sendToClient(message) {
        if (this.ws && this.ws.readyState === 1) {
            try {
                this.ws.send(JSON.stringify(message));
            } catch (error) {
                logger.error({ error: error.message }, 'Failed to send message to client');
            }
        }
    }

    /**
     * Disconnect and cleanup
     */
    disconnect() {
        logger.info('Disconnecting OpenAI Realtime API');

        // Cancel any ongoing response
        if (this.isSpeaking) {
            this.cancelResponse();
        }

        // Close Realtime API WebSocket
        if (this.realtimeWs) {
            try {
                this.realtimeWs.close();
            } catch (error) {
                logger.error({ error: error.message }, 'Error closing Realtime API WebSocket');
            }
            this.realtimeWs = null;
        }

        // Reset state
        this.isConnected = false;
        this.isSpeaking = false;
        this.isListening = false;
        this.sessionId = null;
        this.isCancelling = false;
        this.currentResponseId = null;
        this.cancelledResponseId = null; // Reset cancelled response ID
        this.inputAudioBuffer = [];
        this.outputAudioBuffer = [];
        this.accumulatedAudioBytes = 0; // Reset audio accumulation
        this.hasSentAudio = false; // Reset audio sent flag
        this.lastCommitTime = 0; // Reset commit time tracking
        this.conversationHistory = [];
        this.currentTranscript = '';
        this.interrupted = false;
        this.resumePosition = null;
    }
}

module.exports = OpenAIRealtimeManager;

