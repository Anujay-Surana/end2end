import { useState, useEffect, useRef } from 'react';
import { apiClient } from '../services/apiClient';
import { voiceService } from '../services/voiceService';
import { Capacitor } from '@capacitor/core';
import { MeetingModal } from './MeetingModal';
import type { Meeting } from '../types';
import './ChatView.css';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at?: string;
  functionResults?: any;
}

interface ChatViewProps {
  meetingId?: string;
  onMeetingPrep?: (meetingId: string) => void;
}

export const ChatView: React.FC<ChatViewProps> = ({ meetingId }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [generatingBrief, setGeneratingBrief] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadMessages();
  }, [meetingId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const loadMessages = async () => {
    try {
      const response = await apiClient.getChatMessages(meetingId);
      if (response.success) {
        setMessages(response.messages || []);
      }
    } catch (error) {
      console.error('Error loading messages:', error);
    }
  };

  const sendMessage = async () => {
    if (!inputValue.trim() || loading) return;

    const userMessage: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: inputValue.trim(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');
    setLoading(true);

    try {
      const response = await apiClient.sendChatMessage(userMessage.content, meetingId);

      if (response.success) {
        // Handle function results if any
        const functionResults = response.function_results;
        
        // Replace temp message with actual user message
        const assistantMsg: ChatMessage = {
          ...response.assistant_message,
          functionResults: functionResults || undefined,
        };
        
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.id !== userMessage.id);
          return [
            ...filtered,
            response.user_message,
            assistantMsg,
          ];
        });
        
        // Handle function results
        if (functionResults) {
          const funcName = functionResults.function_name;
          
          if (funcName === 'generate_meeting_brief' && functionResults.meeting) {
            // If brief is already generated server-side, show it directly
            if (functionResults.brief) {
              const meetingWithBrief: Meeting = {
                ...functionResults.meeting,
                summary: functionResults.meeting.summary || 'Meeting',
                start: functionResults.meeting.start || { dateTime: new Date().toISOString() },
                end: functionResults.meeting.end || { dateTime: new Date().toISOString() },
                attendees: functionResults.meeting.attendees || [],
              } as Meeting;
              // Attach brief to meeting object
              (meetingWithBrief as any).brief = functionResults.brief;
              setSelectedMeeting(meetingWithBrief);
            } else {
              // Generate brief client-side if not provided
              handleGenerateBrief(functionResults.meeting);
            }
          }
          // Calendar results are already included in the assistant message content
        }
      }
    } catch (error: any) {
      console.error('Error sending message:', error);
      // Remove temp message on error
      setMessages((prev) => prev.filter((m) => m.id !== userMessage.id));
      
      // Add error message
      const errorMessage: ChatMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: 'Sorry, I encountered an error. Please try again.',
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };
  
  const handleGenerateBrief = async (meeting: any) => {
    setGeneratingBrief(true);
    try {
      // Generate brief using prepMeeting
      const attendees = meeting.attendees || [];
      await apiClient.prepMeeting(meeting, attendees);
      
      // Show meeting modal (brief will be loaded by MeetingModal component)
      setSelectedMeeting({
        ...meeting,
        summary: meeting.summary || 'Meeting',
        start: meeting.start || { dateTime: new Date().toISOString() },
        end: meeting.end || { dateTime: new Date().toISOString() },
        attendees: attendees,
      } as Meeting);
    } catch (error: any) {
      console.error('Error generating brief:', error);
      // Add error message to chat
      const errorMessage: ChatMessage = {
        id: `brief-error-${Date.now()}`,
        role: 'assistant',
        content: 'Sorry, I encountered an error generating the brief. Please try again.',
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setGeneratingBrief(false);
    }
  };

  const handleVoiceStart = async () => {
    console.log('🎤 Voice button clicked');
    console.log('📱 Is native platform:', Capacitor.isNativePlatform());
    console.log('🔌 Voice service available:', !!voiceService);
    
    if (!Capacitor.isNativePlatform()) {
      const platform = Capacitor.getPlatform();
      alert(`Voice recording is only available on native iOS app. Current platform: ${platform}`);
      return;
    }

    try {
      console.log('▶️ Starting voice recording...');
      setIsRecording(true);
      await voiceService.start();
      console.log('✅ Voice recording started');
      
      // Set up transcript callbacks
      voiceService.onPartialTranscript((text) => {
        // Show partial transcript in UI (could add a temporary message)
        console.log('📝 Partial transcript:', text);
      });
      
      voiceService.onFinalTranscript((text) => {
        // Send final transcript as a message
        console.log('✅ Final transcript:', text);
        setInputValue(text);
        setIsRecording(false);
        sendMessage();
      });
    } catch (error: any) {
      console.error('❌ Error starting voice recording:', error);
      console.error('Error details:', {
        message: error?.message,
        name: error?.name,
        stack: error?.stack
      });
      alert(`Failed to start voice recording: ${error?.message || 'Unknown error'}\n\nCheck console for details.`);
      setIsRecording(false);
    }
  };

  const handleVoiceStop = async () => {
    try {
      await voiceService.stop();
      setIsRecording(false);
    } catch (error: any) {
      console.error('Error stopping voice recording:', error);
      setIsRecording(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <>
      <div className="chat-view">
        <div className="chat-messages" ref={chatContainerRef}>
          {messages.length === 0 ? (
            <div className="chat-empty">
              <p className="chat-empty-text">Start a conversation with Shadow</p>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`chat-message chat-message--${message.role}`}
              >
                <div className="chat-message-bubble">
                  <p className="chat-message-content">{message.content}</p>
                  {message.functionResults && message.functionResults.function_name === 'get_calendar_by_date' && (
                    <div className="chat-calendar-results">
                      {message.functionResults.result?.meetings?.length > 0 ? (
                        <div>
                          <p style={{ marginTop: '8px', fontWeight: '500' }}>
                            {message.functionResults.result.count} meeting{message.functionResults.result.count !== 1 ? 's' : ''} found:
                          </p>
                          <ul style={{ marginTop: '8px', paddingLeft: '20px' }}>
                            {message.functionResults.result.meetings.slice(0, 5).map((m: any, idx: number) => (
                              <li key={idx} style={{ marginTop: '4px' }}>
                                {m.summary} {m.start ? `(${new Date(m.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}
                              </li>
                            ))}
                            {message.functionResults.result.meetings.length > 5 && (
                              <li style={{ marginTop: '4px', fontStyle: 'italic' }}>
                                ...and {message.functionResults.result.meetings.length - 5} more
                              </li>
                            )}
                          </ul>
                        </div>
                      ) : (
                        <p style={{ marginTop: '8px', fontStyle: 'italic' }}>No meetings found for this date.</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          {loading && (
            <div className="chat-message chat-message--assistant">
              <div className="chat-message-bubble">
                <div className="chat-typing-indicator">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            </div>
          )}
          {generatingBrief && (
            <div className="chat-message chat-message--assistant">
              <div className="chat-message-bubble">
                <p className="chat-message-content">Generating meeting brief...</p>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-input-container">
          <div className="chat-input-wrapper">
            <input
              type="text"
              className="chat-input"
              placeholder="Type a message..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={handleKeyPress}
              disabled={loading || generatingBrief}
            />
            <button
              className={`chat-voice-button ${isRecording ? 'chat-voice-button--recording' : ''}`}
              onClick={isRecording ? handleVoiceStop : handleVoiceStart}
              disabled={loading || generatingBrief}
              aria-label={isRecording ? 'Stop recording' : 'Start voice recording'}
            >
              {isRecording ? '⏹' : '🎤'}
            </button>
            <button
              className="chat-send-button"
              onClick={sendMessage}
              disabled={!inputValue.trim() || loading || generatingBrief}
              aria-label="Send message"
            >
              →
            </button>
          </div>
        </div>
      </div>
      
      {selectedMeeting && (
        <MeetingModal
          meeting={selectedMeeting}
          brief={selectedMeeting.brief}
          onClose={() => setSelectedMeeting(null)}
        />
      )}
    </>
  );
};

