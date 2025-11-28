/**
 * Chat Panel Service
 * 
 * Handles OpenAI chat integration for the chat panel interface
 */

const fetch = require('node-fetch');
const logger = require('./logger');

class ChatPanelService {
    constructor(openaiApiKey) {
        this.openaiApiKey = openaiApiKey;
    }

    /**
     * Generate chat response using OpenAI
     * @param {string} message - User message
     * @param {Array} conversationHistory - Previous messages in conversation
     * @param {Array} meetings - Today's meetings for context
     * @returns {Promise<string>} - AI response
     */
    async generateResponse(message, conversationHistory = [], meetings = []) {
        try {
            // Build system prompt
            const systemPrompt = this.buildSystemPrompt(meetings);

            // Build messages array
            const messages = [
                { role: 'system', content: systemPrompt },
                ...conversationHistory,
                { role: 'user', content: message }
            ];

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-5',
                    messages: messages,
                    max_completion_tokens: 500,
                })
            });

            if (!response.ok) {
                const errorData = await response.text();
                logger.error({ status: response.status, error: errorData }, 'OpenAI API error');
                throw new Error(`OpenAI API error: ${response.status}`);
            }

            const data = await response.json();
            const responseText = data.choices[0].message.content.trim();
            // Strip markdown formatting for clean display
            return this.stripMarkdown(responseText);
        } catch (error) {
            logger.error({ error: error.message }, 'Error generating chat response');
            throw error;
        }
    }

    /**
     * Generate initial update about today's meetings
     * @param {Array} meetings - Today's meetings
     * @returns {Promise<string>} - Initial update message
     */
    async generateInitialUpdate(meetings) {
        try {
            if (!meetings || meetings.length === 0) {
                return "You have no meetings scheduled for today. I'm here to help whenever you need me!";
            }

            const meetingList = meetings.map((m, idx) => {
                // Handle time display - check if it's an all-day event (date only) vs timed event
                const startTime = m.start?.dateTime || m.start?.date || m.start;
                let timeStr = 'Time TBD';
                
                if (startTime) {
                    if (m.start?.dateTime) {
                        // Timed event - show time
                        timeStr = new Date(startTime).toLocaleTimeString('en-US', {
                            hour: 'numeric',
                            minute: '2-digit',
                            hour12: true
                        });
                    } else if (m.start?.date) {
                        // All-day event - show "All day"
                        timeStr = 'All day';
                    } else if (typeof startTime === 'string') {
                        // Try parsing as date string
                        const parsedDate = new Date(startTime);
                        if (!isNaN(parsedDate.getTime())) {
                            timeStr = parsedDate.toLocaleTimeString('en-US', {
                                hour: 'numeric',
                                minute: '2-digit',
                                hour12: true
                            });
                        }
                    }
                }
                
                const attendees = (m.attendees || []).map(a => a.displayName || a.email).join(', ');
                return `${idx + 1}. ${m.summary || 'Untitled Meeting'} at ${timeStr}${attendees ? ` with ${attendees}` : ''}`;
            }).join('\n');

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-5',
                    messages: [
                        {
                            role: 'system',
                            content: 'You are Shadow, an executive assistant. Provide quick, concise updates about meetings. Keep responses under 100 words.'
                        },
                        {
                            role: 'user',
                            content: `Generate a quick update about today's meetings:\n\n${meetingList}`
                        }
                    ],
                    max_completion_tokens: 200,
                })
            });

            if (!response.ok) {
                throw new Error(`OpenAI API error: ${response.status}`);
            }

            const data = await response.json();
            const responseText = data.choices[0].message.content.trim();
            // Strip markdown formatting for clean display
            return this.stripMarkdown(responseText);
        } catch (error) {
            logger.error({ error: error.message }, 'Error generating initial update');
            // Fallback message
            return `You have ${meetings.length} meeting${meetings.length !== 1 ? 's' : ''} scheduled for today. Ready to help you prepare!`;
        }
    }

    /**
     * Strip markdown formatting from text
     * @param {string} text - Text with markdown
     * @returns {string} - Clean text without markdown
     */
    stripMarkdown(text) {
        if (!text) return text;
        // Remove markdown formatting: **bold**, *italic*, `code`, etc.
        return text
            .replace(/\*\*([^*]+)\*\*/g, '$1') // Bold
            .replace(/\*([^*]+)\*/g, '$1') // Italic
            .replace(/`([^`]+)`/g, '$1') // Code
            .replace(/#{1,6}\s+/g, '') // Headers
            .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // Links, keep text
            .trim();
    }

    /**
     * Build system prompt with meeting context
     * @param {Array} meetings - Today's meetings
     * @returns {string} - System prompt
     */
    buildSystemPrompt(meetings = []) {
        let prompt = `You are Shadow, an executive assistant. You help users prepare for meetings and manage their day.

Your role:
- Provide quick, concise updates about meetings
- Answer questions about meeting attendees, times, and topics
- Help users prepare for upcoming meetings
- Be friendly, professional, and efficient

Keep responses brief and actionable. Maximum 100 words per response unless the user asks for more detail.`;

        if (meetings && meetings.length > 0) {
            prompt += `\n\nToday's meetings:\n`;
            meetings.forEach((m, idx) => {
                // Handle time display - check if it's an all-day event (date only) vs timed event
                const startTime = m.start?.dateTime || m.start?.date || m.start;
                let timeStr = 'Time TBD';
                
                if (startTime) {
                    if (m.start?.dateTime) {
                        // Timed event - show time
                        timeStr = new Date(startTime).toLocaleTimeString('en-US', {
                            hour: 'numeric',
                            minute: '2-digit',
                            hour12: true
                        });
                    } else if (m.start?.date) {
                        // All-day event - show "All day"
                        timeStr = 'All day';
                    } else if (typeof startTime === 'string') {
                        // Try parsing as date string
                        const parsedDate = new Date(startTime);
                        if (!isNaN(parsedDate.getTime())) {
                            timeStr = parsedDate.toLocaleTimeString('en-US', {
                                hour: 'numeric',
                                minute: '2-digit',
                                hour12: true
                            });
                        }
                    }
                }
                
                const attendees = (m.attendees || []).map(a => a.displayName || a.email).join(', ') || 'No attendees';
                prompt += `${idx + 1}. ${m.summary || 'Untitled Meeting'} at ${timeStr} with ${attendees}\n`;
            });
        }

        return prompt;
    }
}

module.exports = ChatPanelService;

