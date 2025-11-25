import { useState } from 'react';
import { apiClient } from '../services/apiClient';
import type { DayPrep as DayPrepType } from '../types';
import './DayPrep.css';

interface DayPrepProps {
  date: Date;
  onClose: () => void;
}

export const DayPrep: React.FC<DayPrepProps> = ({ date, onClose }) => {
  const [dayPrep, setDayPrep] = useState<DayPrepType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formatDate = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const generateDayPrep = async () => {
    setLoading(true);
    setError(null);
    try {
      const dateStr = formatDate(date);
      const response = await apiClient.dayPrep(dateStr);
      setDayPrep(response.dayPrep);
    } catch (err: any) {
      setError(err.message || 'Failed to generate day prep');
    } finally {
      setLoading(false);
    }
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
    <div className="day-prep-overlay" onClick={onClose}>
      <div className="day-prep-content" onClick={(e) => e.stopPropagation()}>
        <button className="close-button" onClick={onClose}>×</button>
        <h2>Day Prep - {formatDisplayDate(date)}</h2>

        {!dayPrep && !loading && (
          <div className="prep-prompt">
            <p>Generate comprehensive day preparation brief</p>
            <button className="generate-button" onClick={generateDayPrep}>
              Generate Day Prep
            </button>
          </div>
        )}

        {loading && (
          <div className="loading">Generating day prep...</div>
        )}

        {error && (
          <div className="error-message">{error}</div>
        )}

        {dayPrep && (
          <div className="day-prep-content-inner">
            {dayPrep.summary && (
              <div className="prep-section">
                <h3>Day Summary</h3>
                <p>{dayPrep.summary}</p>
              </div>
            )}
            {dayPrep.meetings && dayPrep.meetings.length > 0 && (
              <div className="prep-section">
                <h3>Meetings ({dayPrep.meetings.length})</h3>
                <ul className="meetings-list">
                  {dayPrep.meetings.map((meeting) => (
                    <li key={meeting.id}>
                      <strong>{meeting.summary || meeting.title}</strong>
                      {meeting.start?.dateTime && (
                        <span className="meeting-time">
                          {' '}at {new Date(meeting.start.dateTime).toLocaleTimeString()}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

