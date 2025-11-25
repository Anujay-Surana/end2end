import { useState, useEffect } from 'react';
import { apiClient } from '../services/apiClient';
import type { Meeting } from '../types';
import { MeetingList } from './MeetingList';
import { MeetingPrep } from './MeetingPrep';
import './CalendarView.css';

export const CalendarView: React.FC = () => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);

  useEffect(() => {
    loadMeetings();
  }, [currentDate]);

  const formatDate = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const loadMeetings = async () => {
    setLoading(true);
    setError(null);
    try {
      const dateStr = formatDate(currentDate);
      const response = await apiClient.getMeetingsForDay(dateStr);
      setMeetings(response.meetings || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load meetings');
    } finally {
      setLoading(false);
    }
  };

  const changeDay = (days: number) => {
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + days);
    setCurrentDate(newDate);
  };

  const formatDisplayDate = (date: Date): string => {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <div className="calendar-view">
      <div className="calendar-header">
        <button className="nav-button" onClick={() => changeDay(-1)}>
          ←
        </button>
        <h2 className="date-title">{formatDisplayDate(currentDate)}</h2>
        <button className="nav-button" onClick={() => changeDay(1)}>
          →
        </button>
      </div>

      <button className="refresh-button" onClick={loadMeetings} disabled={loading}>
        {loading ? 'Loading...' : 'Refresh'}
      </button>

      {error && <div className="error-message">{error}</div>}

      {loading && meetings.length === 0 ? (
        <div className="loading">Loading meetings...</div>
      ) : (
        <MeetingList
          meetings={meetings}
          onMeetingSelect={setSelectedMeeting}
          selectedMeeting={selectedMeeting}
        />
      )}

      {selectedMeeting && (
        <MeetingPrep
          meeting={selectedMeeting}
          onClose={() => setSelectedMeeting(null)}
        />
      )}
    </div>
  );
};

