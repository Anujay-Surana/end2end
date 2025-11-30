import { useState, useEffect, useRef } from 'react';
import { apiClient } from '../services/apiClient';
import { voiceService } from '../services/voiceService';
import { Capacitor } from '@capacitor/core';
import './ChatView.css';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at?: string;
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
        // Replace temp message with actual user message
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.id !== userMessage.id);
          return [
            ...filtered,
            response.user_message,
            response.assistant_message,
          ];
        });
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

  const handleVoiceStart = async () => {
    if (!Capacitor.isNativePlatform()) {
      alert('Voice recording is only available on native iOS app');
      return;
    }

    try {
      setIsRecording(true);
      await voiceService.start();
      
      // Set up transcript callbacks
      voiceService.onPartialTranscript((text) => {
        // Show partial transcript in UI (could add a temporary message)
        console.log('Partial transcript:', text);
      });
      
      voiceService.onFinalTranscript((text) => {
        // Send final transcript as a message
        setInputValue(text);
        setIsRecording(false);
        sendMessage();
      });
    } catch (error: any) {
      console.error('Error starting voice recording:', error);
      alert(error.message || 'Failed to start voice recording');
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
            disabled={loading}
          />
          <button
            className={`chat-voice-button ${isRecording ? 'chat-voice-button--recording' : ''}`}
            onClick={isRecording ? handleVoiceStop : handleVoiceStart}
            disabled={loading}
            aria-label={isRecording ? 'Stop recording' : 'Start voice recording'}
          >
            {isRecording ? '⏹' : '🎤'}
          </button>
          <button
            className="chat-send-button"
            onClick={sendMessage}
            disabled={!inputValue.trim() || loading}
            aria-label="Send message"
          >
            →
          </button>
        </div>
      </div>
    </div>
  );
};

