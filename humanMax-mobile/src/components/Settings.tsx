import { useState, useEffect } from 'react';
import { authService } from '../services/authService';
import { apiClient } from '../services/apiClient';
import type { Account } from '../types';
import './Settings.css';

interface SettingsProps {
  onSignOut: () => void;
}

export const Settings: React.FC<SettingsProps> = ({ onSignOut }) => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.getAccounts();
      setAccounts(response.accounts || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  };

  const handleAddAccount = async () => {
    try {
      await authService.addAccount();
      await loadAccounts();
    } catch (err: any) {
      setError(err.message || 'Failed to add account');
    }
  };

  const handleRemoveAccount = async (accountId: string) => {
    if (!confirm('Are you sure you want to remove this account?')) {
      return;
    }
    try {
      await apiClient.deleteAccount(accountId);
      await loadAccounts();
    } catch (err: any) {
      setError(err.message || 'Failed to remove account');
    }
  };

  const handleSetPrimary = async (accountId: string) => {
    try {
      await apiClient.setPrimaryAccount(accountId);
      await loadAccounts();
    } catch (err: any) {
      setError(err.message || 'Failed to set primary account');
    }
  };

  const handleSignOut = async () => {
    try {
      await authService.signOut();
      onSignOut();
    } catch (err: any) {
      setError(err.message || 'Failed to sign out');
    }
  };

  const user = authService.getCurrentUser();

  return (
    <div className="settings-view">
      <h2>Settings</h2>

      {user && (
        <div className="user-section">
          <h3>User</h3>
          <div className="user-info">
            {user.picture && <img src={user.picture} alt={user.name} className="user-avatar" />}
            <div>
              <p className="user-name">{user.name}</p>
              <p className="user-email">{user.email}</p>
            </div>
          </div>
        </div>
      )}

      <div className="accounts-section">
        <div className="section-header">
          <h3>Connected Accounts</h3>
          <button className="add-account-button" onClick={handleAddAccount}>
            + Add Account
          </button>
        </div>

        {loading && <div className="loading">Loading accounts...</div>}
        {error && <div className="error-message">{error}</div>}

        {accounts.length === 0 && !loading && (
          <p className="no-accounts">No accounts connected</p>
        )}

        <div className="accounts-list">
          {accounts.map((account) => (
            <div key={account.id} className="account-item">
              <div className="account-info">
                <p className="account-email">{account.email}</p>
                <p className="account-name">{account.name}</p>
                {account.is_primary && (
                  <span className="primary-badge">Primary</span>
                )}
              </div>
                  <div className="account-actions">
                    {!account.is_primary && (
                      <button
                        className="action-button"
                        onClick={() => handleSetPrimary(account.id)}
                      >
                        Set Primary
                      </button>
                    )}
                    {!account.is_primary && (
                      <button
                        className="action-button danger"
                        onClick={() => handleRemoveAccount(account.id)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
            </div>
          ))}
        </div>
      </div>

      <div className="sign-out-section">
        <button className="sign-out-button" onClick={handleSignOut}>
          Sign Out
        </button>
      </div>
    </div>
  );
};

