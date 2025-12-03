import { useState } from 'react';
import type { Meeting } from '../types';
import { VoicePrep } from './VoicePrep';
import './MeetingCardModal.css';

interface MeetingCardModalProps {
  meeting: Meeting;
  onClose: () => void;
  onPrepMe?: (meeting: Meeting) => void;
}

export const MeetingCardModal: React.FC<MeetingCardModalProps> = ({
  meeting,
  onClose,
  onPrepMe,
}) => {
  const [showVoicePrep, setShowVoicePrep] = useState(false);

  const formatTime = (dateTime: string | { dateTime?: string; date?: string } | undefined) => {
    try {
      let dt: Date;
      if (typeof dateTime === 'string') {
        dt = new Date(dateTime);
      } else if (dateTime && typeof dateTime === 'object') {
        dt = new Date(dateTime.dateTime || dateTime.date || '');
      } else {
        return '';
      }
      return dt.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return '';
    }
  };

  const formatDate = (dateTime: string | { dateTime?: string; date?: string } | undefined) => {
    try {
      let dt: Date;
      if (typeof dateTime === 'string') {
        dt = new Date(dateTime);
      } else if (dateTime && typeof dateTime === 'object') {
        dt = new Date(dateTime.dateTime || dateTime.date || '');
      } else {
        return '';
      }
      return dt.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return '';
    }
  };

  const handlePrepMe = () => {
    if (onPrepMe) {
      onPrepMe(meeting);
    }
    onClose();
  };

  const handleVoicePrep = () => {
    setShowVoicePrep(true);
  };

  const meetingStart = meeting.start?.dateTime || meeting.start?.date || '';
  const meetingEnd = meeting.end?.dateTime || meeting.end?.date || '';
  const attendees = meeting.attendees || [];
  const attendeeCount = Array.isArray(attendees) ? attendees.length : 0;

  if (showVoicePrep) {
    return (
      <VoicePrep
        meeting={meeting}
        brief={null}
        onClose={() => {
          setShowVoicePrep(false);
          onClose();
        }}
      />
    );
  }

  return (
    <div className="meeting-card-modal-overlay" onClick={onClose}>
      <div className="meeting-card-modal" onClick={(e) => e.stopPropagation()}>
        <button className="meeting-card-modal-close" onClick={onClose}>
          ✕
        </button>
        
        <div className="meeting-card-modal-content">
          <h2 className="meeting-card-modal-title">{meeting.summary || 'Untitled Meeting'}</h2>
          
          {meetingStart && (
            <div className="meeting-card-modal-info">
              <div className="meeting-card-modal-info-item">
                <span className="meeting-card-modal-time">
                  {formatDate(meetingStart)} at {formatTime(meetingStart)}
                  {meetingEnd && ` - ${formatTime(meetingEnd)}`}
                </span>
              </div>
            </div>
          )}

          {attendeeCount > 0 && (
            <div className="meeting-card-modal-info">
              <span className="meeting-card-modal-attendees">
                {attendeeCount} {attendeeCount === 1 ? 'attendee' : 'attendees'}
              </span>
            </div>
          )}

          <div className="meeting-card-modal-actions">
            <button
              className="meeting-card-modal-prep-button"
              onClick={handlePrepMe}
            >
              Prep Me
            </button>
            <button
              className="meeting-card-modal-voice-button"
              onClick={handleVoicePrep}
              aria-label="Voice prep"
            >
              🎤
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

