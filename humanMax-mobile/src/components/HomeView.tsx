import { useState, useEffect } from 'react';
import { apiClient } from '../services/apiClient';
import type { Meeting } from '../types';
import './HomeView.css';

interface HomeViewProps {
  onMeetingClick: (meeting: Meeting) => void;
}

export const HomeView: React.FC<HomeViewProps> = ({ onMeetingClick }) => {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTodaysMeetings();
  }, []);

  const loadTodaysMeetings = async () => {
    try {
      setLoading(true);
      setError(null);
      const today = new Date().toISOString().split('T')[0];
      const response = await apiClient.getMeetingsForDay(today);
      setMeetings(response.meetings || []);
    } catch (err: any) {
      console.error('Error loading meetings:', err);
      setError(err.message || 'Failed to load meetings');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = () => {
    const now = new Date();
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    };
    
    const formatted = now.toLocaleDateString('en-US', options);
    // Convert "Tuesday, December 26, 2026" to "Tuesday, 26th December 2026"
    const parts = formatted.split(', ');
    if (parts.length >= 2) {
      const weekday = parts[0];
      const rest = parts.slice(1).join(', ');
      const match = rest.match(/(\w+)\s+(\d+),?\s*(\d+)?/);
      if (match) {
        const month = match[1];
        const day = parseInt(match[2]);
        const year = match[3] || now.getFullYear();
        const suffix = getDaySuffix(day);
        return `${weekday}, ${day}${suffix} ${month} ${year}`;
      }
    }
    return formatted;
  };

  const getDaySuffix = (day: number): string => {
    if (day >= 11 && day <= 13) return 'th';
    switch (day % 10) {
      case 1: return 'st';
      case 2: return 'nd';
      case 3: return 'rd';
      default: return 'th';
    }
  };

  const formatMeetingTime = (meeting: Meeting): string => {
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

  const formatAttendees = (meeting: Meeting): string => {
    const attendees = meeting.attendees || [];
    if (attendees.length === 0) return 'No attendees';
    
    const names = attendees
      .slice(0, 3)
      .map(a => a.displayName || a.email?.split('@')[0] || 'Unknown')
      .join(', ');
    
    if (attendees.length > 3) {
      return `${names} +${attendees.length - 3} more`;
    }
    return names;
  };

  const getMeetingSummary = (meeting: Meeting): string => {
    // For now, return a placeholder. This will be populated from pre-generated briefs later.
    if (meeting.description) {
      return meeting.description.substring(0, 80) + (meeting.description.length > 80 ? '...' : '');
    }
    return 'Tap to view meeting details and prepare';
  };

  return (
    <div className="home-view">
      <div className="home-header">
        <h1 className="home-date">{formatDate()}</h1>
        <p className="home-subtitle">Today's Schedule</p>
      </div>

      <div className="home-content">
        {loading && (
          <div className="home-loading">
            <div className="home-loading-spinner"></div>
            <p>Loading your meetings...</p>
          </div>
        )}

        {error && (
          <div className="home-error">
            <p>{error}</p>
            <button className="home-retry-button" onClick={loadTodaysMeetings}>
              Try Again
            </button>
          </div>
        )}

        {!loading && !error && meetings.length === 0 && (
          <div className="home-empty">
            <div className="home-empty-icon">📅</div>
            <h3>No meetings today</h3>
            <p>Enjoy your free day!</p>
          </div>
        )}

        {!loading && !error && meetings.length > 0 && (
          <div className="home-meetings-list">
            {meetings.map((meeting) => (
              <div
                key={meeting.id}
                className="meeting-card"
                onClick={() => onMeetingClick(meeting)}
              >
                <div className="meeting-card-time">
                  {formatMeetingTime(meeting)}
                </div>
                <div className="meeting-card-content">
                  <h3 className="meeting-card-title">
                    {meeting.summary || 'Untitled Meeting'}
                  </h3>
                  <p className="meeting-card-attendees">
                    {formatAttendees(meeting)}
                  </p>
                  <p className="meeting-card-summary">
                    {getMeetingSummary(meeting)}
                  </p>
                </div>
                <div className="meeting-card-arrow">→</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

