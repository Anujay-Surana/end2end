import { useState, useEffect, useRef } from 'react';
import { apiClient } from '../services/apiClient';
import { voiceService } from '../services/voiceService';
import { Capacitor } from '@capacitor/core';
import type { Meeting } from '../types';
import './PrepChatView.css';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at?: string;
}

interface PrepChatViewProps {
  meeting: Meeting;
  onClose: () => void;
  onListenIn: () => void;
}

export const PrepChatView: React.FC<PrepChatViewProps> = ({
  meeting,
  onClose,
  onListenIn,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initializeChat();
  }, [meeting.id]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const initializeChat = async () => {
    setInitializing(true);
    try {
      // Load any existing messages for this meeting
      const response = await apiClient.getChatMessages(meeting.id);
      if (response.success && response.messages) {
        setMessages(response.messages);
      }
      
      // If no messages, add a welcome message
      if (!response.messages || response.messages.length === 0) {
        const welcomeMessage: ChatMessage = {
          id: `welcome-${Date.now()}`,
          role: 'assistant',
          content: `I'm ready to help you prepare for "${meeting.summary || 'your meeting'}". You can ask me about the attendees, agenda, or any other questions you have about this meeting.`,
        };
        setMessages([welcomeMessage]);
      }
    } catch (error) {
      console.error('Error initializing chat:', error);
      // Add a fallback welcome message
      const welcomeMessage: ChatMessage = {
        id: `welcome-${Date.now()}`,
        role: 'assistant',
        content: `Let's prepare for "${meeting.summary || 'your meeting'}". What would you like to know?`,
      };
      setMessages([welcomeMessage]);
    } finally {
      setInitializing(false);
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
      const response = await apiClient.sendChatMessage(userMessage.content, meeting.id);

      if (response.success) {
        const assistantMsg: ChatMessage = {
          ...response.assistant_message,
        };
        
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.id !== userMessage.id);
          return [
            ...filtered,
            response.user_message,
            assistantMsg,
          ];
        });
      }
    } catch (error: any) {
      console.error('Error sending message:', error);
      setMessages((prev) => prev.filter((m) => m.id !== userMessage.id));
      
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
      alert('Voice recording is only available on native iOS app.');
      return;
    }

    try {
      setIsRecording(true);
      await voiceService.start();
      
      voiceService.onPartialTranscript((text) => {
        console.log('Partial transcript:', text);
      });
      
      voiceService.onFinalTranscript((text) => {
        setInputValue(text);
        setIsRecording(false);
        // Auto-send after voice input
        setTimeout(() => {
          if (text.trim()) {
            sendMessage();
          }
        }, 100);
      });
    } catch (error: any) {
      console.error('Error starting voice:', error);
      alert(`Failed to start voice: ${error?.message || 'Unknown error'}`);
      setIsRecording(false);
    }
  };

  const handleVoiceStop = async () => {
    try {
      await voiceService.stop();
      setIsRecording(false);
    } catch (error) {
      console.error('Error stopping voice:', error);
      setIsRecording(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const formatTime = (meeting: Meeting): string => {
    const startTime = meeting.start?.dateTime || meeting.start?.date;
    if (!startTime) return '';
    
    try {
      const date = new Date(startTime);
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return '';
    }
  };

  return (
    <div className="prep-chat-view">
      <div className="prep-chat-header">
        <button className="prep-chat-back" onClick={onClose}>
          ←
        </button>
        <div className="prep-chat-header-info">
          <h2 className="prep-chat-title">{meeting.summary || 'Meeting Prep'}</h2>
          <span className="prep-chat-time">{formatTime(meeting)}</span>
        </div>
        <button className="prep-chat-listen-button" onClick={onListenIn}>
          Listen In
        </button>
      </div>

      <div className="prep-chat-messages" ref={chatContainerRef}>
        {initializing ? (
          <div className="prep-chat-initializing">
            <div className="prep-chat-spinner"></div>
            <p>Preparing your meeting context...</p>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <div
                key={message.id}
                className={`prep-chat-message prep-chat-message--${message.role}`}
              >
                <div className="prep-chat-message-bubble">
                  <p className="prep-chat-message-content">{message.content}</p>
                </div>
              </div>
            ))}
            {loading && (
              <div className="prep-chat-message prep-chat-message--assistant">
                <div className="prep-chat-message-bubble">
                  <div className="prep-chat-typing">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      <div className="prep-chat-input-container">
        <div className="prep-chat-input-wrapper">
          <input
            type="text"
            className="prep-chat-input"
            placeholder="Ask about this meeting..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            disabled={loading || initializing}
          />
          <button
            className={`prep-chat-voice-button ${isRecording ? 'prep-chat-voice-button--recording' : ''}`}
            onClick={isRecording ? handleVoiceStop : handleVoiceStart}
            disabled={loading || initializing}
            aria-label={isRecording ? 'Stop recording' : 'Start voice recording'}
          >
            {isRecording ? '⏹' : '🎤'}
          </button>
          <button
            className="prep-chat-send-button"
            onClick={sendMessage}
            disabled={!inputValue.trim() || loading || initializing}
            aria-label="Send message"
          >
            →
          </button>
        </div>
      </div>
    </div>
  );
};

