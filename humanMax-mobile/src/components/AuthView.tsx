import { useState, useEffect } from 'react';
import { authService } from '../services/authService';
import { apiClient } from '../services/apiClient';
import './AuthView.css';

interface AuthViewProps {
  onSignIn: () => void;
}

export const AuthView: React.FC<AuthViewProps> = ({ onSignIn }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check if this is first-time user (no welcome message sent yet)
    const checkFirstTime = async () => {
      try {
        // Check if user has any chat messages (indicates returning user)
        const messages = await apiClient.getChatMessages(undefined, 1);
        if (!messages.success || (messages.messages && messages.messages.length === 0)) {
          // First-time user - will show welcome after sign-in
        }
      } catch {
        // Error checking - assume first-time user
      }
    };
    checkFirstTime();
  }, []);

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      await authService.signIn();
      
      // Show welcome message for first-time users
      try {
        const messages = await apiClient.getChatMessages(undefined, 1);
        if (!messages.success || (messages.messages && messages.messages.length === 0)) {
          // Send welcome message
          await apiClient.sendChatMessage(
            'Welcome to Shadow. Your daily briefing will appear at 9 AM.'
          );
        }
      } catch (err) {
        console.error('Error sending welcome message:', err);
        // Don't fail sign-in if welcome message fails
      }
      
      onSignIn();
    } catch (err: any) {
      setError(err.message || 'Sign in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-view">
      <div className="auth-container">
        <h1 className="auth-title">Shadow</h1>
        <p className="auth-subtitle">AI-Powered Meeting Preparation</p>
        <button
          className="auth-sign-in-button"
          onClick={handleSignIn}
          disabled={loading}
        >
          {loading ? 'Signing in...' : 'Sign in with Google'}
        </button>
        {error && <p className="auth-error">{error}</p>}
      </div>
    </div>
  );
};
