import { useState } from 'react';
import { apiClient } from '../services/apiClient';
import type { Meeting, MeetingPrep as MeetingPrepType } from '../types';
import './MeetingPrep.css';

interface MeetingPrepProps {
  meeting: Meeting;
  onClose: () => void;
}

export const MeetingPrep: React.FC<MeetingPrepProps> = ({ meeting, onClose }) => {
  const [prep, setPrep] = useState<MeetingPrepType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generatePrep = async () => {
    setLoading(true);
    setError(null);
    try {
      const attendees = meeting.attendees || [];
      const response = await apiClient.prepMeeting(meeting, attendees);
      setPrep(response.prep);
    } catch (err: any) {
      setError(err.message || 'Failed to generate prep');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="meeting-prep-overlay" onClick={onClose}>
      <div className="meeting-prep-content" onClick={(e) => e.stopPropagation()}>
        <button className="close-button" onClick={onClose}>×</button>
        <h2>{meeting.summary || meeting.title || 'Meeting Prep'}</h2>

        {!prep && !loading && (
          <div className="prep-prompt">
            <p>Generate AI-powered meeting preparation brief</p>
            <button className="generate-button" onClick={generatePrep}>
              Generate Prep
            </button>
          </div>
        )}

        {loading && (
          <div className="loading">Generating prep brief...</div>
        )}

        {error && (
          <div className="error-message">{error}</div>
        )}

        {prep && (
          <div className="prep-content">
            {prep.summary && (
              <div className="prep-section">
                <h3>Summary</h3>
                <p>{prep.summary}</p>
              </div>
            )}
            {prep.sections.map((section, idx) => (
              <div key={idx} className="prep-section">
                <h3>{section.title}</h3>
                <div className="section-content" dangerouslySetInnerHTML={{ __html: section.content }} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

