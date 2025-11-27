import { useState } from 'react';
import { authService } from '../services/authService';
import './AuthView.css';

interface AuthViewProps {
  onSignIn: () => void;
}

export const AuthView: React.FC<AuthViewProps> = ({ onSignIn }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      await authService.signIn();
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
