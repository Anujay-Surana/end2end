import { useState, useEffect } from 'react';
import type { Meeting } from '../types';
import './MeetingDetailModal.css';

interface MeetingDetailModalProps {
  meeting: Meeting;
  onClose: () => void;
  onPrep: (meeting: Meeting) => void;
}

export const MeetingDetailModal: React.FC<MeetingDetailModalProps> = ({
  meeting,
  onClose,
  onPrep,
}) => {
  const [brief, setBrief] = useState<any>(null);

  useEffect(() => {
    // Check if meeting already has brief attached
    if ((meeting as any).brief) {
      setBrief((meeting as any).brief);
    }
  }, [meeting]);

  const formatTime = (dateTime: string | undefined): string => {
    if (!dateTime) return '';
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

  const formatDate = (dateTime: string | undefined): string => {
    if (!dateTime) return '';
    try {
      const dt = new Date(dateTime);
      return dt.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return '';
    }
  };

  const meetingStart = meeting.start?.dateTime || meeting.start?.date || '';
  const meetingEnd = meeting.end?.dateTime || meeting.end?.date || '';
  const attendees = meeting.attendees || [];
  const location = meeting.location || '';

  const getExtendedSummary = (): string => {
    if (brief?.summary) {
      return brief.summary;
    }
    if (meeting.description) {
      return meeting.description.substring(0, 200) + (meeting.description.length > 200 ? '...' : '');
    }
    return 'No meeting description available. Click "Prep" to generate a meeting brief with AI-powered insights.';
  };

  const getKeyInsights = (): string[] => {
    if (brief?.recommendations && brief.recommendations.length > 0) {
      return brief.recommendations.slice(0, 4).map((rec: any) =>
        typeof rec === 'string' ? rec : (rec.text || rec.description || JSON.stringify(rec))
      );
    }
    if (brief?.actionItems && brief.actionItems.length > 0) {
      return brief.actionItems.slice(0, 4).map((item: any) =>
        typeof item === 'string' ? item : (item.text || item.description || JSON.stringify(item))
      );
    }
    // Placeholder insights
    return [
      'Generate a meeting brief to see key insights',
      'AI will analyze attendees and context',
      'Get personalized recommendations',
    ];
  };

  return (
    <div className="meeting-detail-overlay" onClick={onClose}>
      <div className="meeting-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="meeting-detail-header">
          <button className="meeting-detail-close" onClick={onClose}>
            ←
          </button>
          <span className="meeting-detail-header-title">Meeting Details</span>
        </div>

        <div className="meeting-detail-content">
          <h1 className="meeting-detail-title">
            {meeting.summary || 'Untitled Meeting'}
          </h1>

          {/* Time Section */}
          <div className="meeting-detail-section">
            <div className="meeting-detail-row">
              <span className="meeting-detail-icon">🕐</span>
              <div className="meeting-detail-info">
                <span className="meeting-detail-label">Time</span>
                <span className="meeting-detail-value">
                  {formatDate(meetingStart)}
                  {meetingStart && (
                    <>
                      {' '}at {formatTime(meetingStart)}
                      {meetingEnd && ` - ${formatTime(meetingEnd)}`}
                    </>
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Location Section */}
          {location && (
            <div className="meeting-detail-section">
              <div className="meeting-detail-row">
                <span className="meeting-detail-icon">📍</span>
                <div className="meeting-detail-info">
                  <span className="meeting-detail-label">Location</span>
                  <span className="meeting-detail-value">{location}</span>
                </div>
              </div>
            </div>
          )}

          {/* Attendees Section */}
          {attendees.length > 0 && (
            <div className="meeting-detail-section">
              <div className="meeting-detail-row">
                <span className="meeting-detail-icon">👥</span>
                <div className="meeting-detail-info">
                  <span className="meeting-detail-label">
                    Attendees ({attendees.length})
                  </span>
                  <div className="meeting-detail-attendees">
                    {attendees.slice(0, 6).map((attendee, idx) => (
                      <span key={idx} className="meeting-detail-attendee">
                        {attendee.displayName || attendee.email}
                        {attendee.organizer && ' (organizer)'}
                      </span>
                    ))}
                    {attendees.length > 6 && (
                      <span className="meeting-detail-attendee meeting-detail-attendee-more">
                        +{attendees.length - 6} more
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Summary Section */}
          <div className="meeting-detail-section">
            <h3 className="meeting-detail-section-title">Summary</h3>
            <p className="meeting-detail-summary">{getExtendedSummary()}</p>
          </div>

          {/* Key Insights Section */}
          <div className="meeting-detail-section">
            <h3 className="meeting-detail-section-title">Key Insights</h3>
            <ul className="meeting-detail-insights">
              {getKeyInsights().map((insight, idx) => (
                <li key={idx} className="meeting-detail-insight">
                  {insight}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Prep Button */}
        <div className="meeting-detail-footer">
          <button
            className="meeting-detail-prep-button"
            onClick={() => onPrep(meeting)}
          >
            Prep
          </button>
        </div>
      </div>
    </div>
  );
};

