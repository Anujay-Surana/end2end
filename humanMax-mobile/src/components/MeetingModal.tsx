import { useState, useEffect } from 'react';
import { ChatView } from './ChatView';
import type { Meeting } from '../types';
import './MeetingModal.css';

interface MeetingModalProps {
  meeting: Meeting;
  brief?: any;
  onClose: () => void;
  onPrepareNow?: () => void;
}

export const MeetingModal: React.FC<MeetingModalProps> = ({
  meeting,
  brief,
  onClose,
  onPrepareNow,
}) => {
  const [showChat, setShowChat] = useState(false);
  const [loadingBrief, setLoadingBrief] = useState(false);
  const [storedBrief, setStoredBrief] = useState<any>(brief);

  useEffect(() => {
    // If brief not provided, try to load from stored briefs
    if (!brief && meeting.id) {
      loadStoredBrief();
    } else if (brief) {
      setStoredBrief(brief);
    }
  }, [meeting.id, brief]);

  const loadStoredBrief = async () => {
    try {
      setLoadingBrief(true);
      // Try to fetch stored brief from database
      // For now, if no brief is provided, user can click "Prepare Now" to generate
      setLoadingBrief(false);
    } catch (error) {
      console.error('Error loading brief:', error);
      setLoadingBrief(false);
    }
  };

  const handlePrepareNow = () => {
    if (onPrepareNow) {
      onPrepareNow();
    }
    setShowChat(true);
  };

  const formatTime = (dateTime: string) => {
    try {
      const dt = new Date(dateTime);
      return dt.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return dateTime;
    }
  };

  const formatDate = (dateTime: string) => {
    try {
      const dt = new Date(dateTime);
      return dt.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '';
    }
  };

  const meetingStart = meeting.start?.dateTime || meeting.start?.date || '';
  const meetingEnd = meeting.end?.dateTime || meeting.end?.date || '';
  const attendees = meeting.attendees || [];
  const agenda = meeting.description || '';

  if (showChat) {
    return (
      <div className="meeting-modal">
        <div className="meeting-modal-header">
          <button className="meeting-modal-close" onClick={onClose}>
            ✕
          </button>
          <h2 className="meeting-modal-title">{meeting.summary || 'Meeting'}</h2>
        </div>
        <div className="meeting-modal-chat">
          <ChatView meetingId={meeting.id} />
        </div>
      </div>
    );
  }

  return (
    <div className="meeting-modal-overlay" onClick={onClose}>
      <div className="meeting-modal" onClick={(e) => e.stopPropagation()}>
        <div className="meeting-modal-header">
          <button className="meeting-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="meeting-modal-content">
          <h2 className="meeting-modal-title">{meeting.summary || 'Untitled Meeting'}</h2>

          {meetingStart && (
            <div className="meeting-modal-info">
              <div className="meeting-modal-info-item">
                <span className="meeting-modal-info-label">Time</span>
                <span className="meeting-modal-info-value">
                  {formatDate(meetingStart)} at {formatTime(meetingStart)}
                  {meetingEnd && ` - ${formatTime(meetingEnd)}`}
                </span>
              </div>
            </div>
          )}

          {attendees.length > 0 && (
            <div className="meeting-modal-info">
              <div className="meeting-modal-info-item">
                <span className="meeting-modal-info-label">Attendees</span>
                <div className="meeting-modal-attendees">
                  {attendees.slice(0, 5).map((attendee, idx) => (
                    <span key={idx} className="meeting-modal-attendee">
                      {attendee.displayName || attendee.email}
                    </span>
                  ))}
                  {attendees.length > 5 && (
                    <span className="meeting-modal-attendee">
                      +{attendees.length - 5} more
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {agenda && (
            <div className="meeting-modal-info">
              <div className="meeting-modal-info-item">
                <span className="meeting-modal-info-label">Agenda</span>
                <p className="meeting-modal-agenda">{agenda.substring(0, 200)}{agenda.length > 200 ? '...' : ''}</p>
              </div>
            </div>
          )}

          {storedBrief && (
            <div className="meeting-modal-brief-preview">
              <p className="meeting-modal-brief-text">
                Brief ready: {storedBrief.summary?.substring(0, 150) || 'Brief available'}
                {storedBrief.summary && storedBrief.summary.length > 150 ? '...' : ''}
              </p>
            </div>
          )}

          <button
            className="meeting-modal-prepare-button"
            onClick={handlePrepareNow}
            disabled={loadingBrief}
          >
            {loadingBrief ? 'Loading...' : 'Prepare Now'}
          </button>
        </div>
      </div>
    </div>
  );
};

