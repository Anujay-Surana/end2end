import { memo } from 'react';
import type { Meeting } from '../types';
import './MeetingList.css';

interface MeetingListProps {
  meetings: Meeting[];
  onMeetingSelect: (meeting: Meeting) => void;
  selectedMeeting: Meeting | null;
}

const MeetingItem = memo(({ 
  meeting, 
  isSelected, 
  onSelect 
}: { 
  meeting: Meeting; 
  isSelected: boolean; 
  onSelect: () => void;
}) => {
  const formatTime = (dateTime: string | undefined): string => {
    if (!dateTime) return '';
    try {
      const date = new Date(dateTime);
      return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return '';
    }
  };

  return (
    <div
      className={`meeting-item ${isSelected ? 'selected' : ''}`}
      onClick={onSelect}
    >
      <div className="meeting-time-badge">
        {formatTime(meeting.start?.dateTime)}
      </div>
      <div className="meeting-info">
        <h3 className="meeting-title">{meeting.summary || meeting.title || 'Untitled Meeting'}</h3>
        {meeting.location && (
          <p className="meeting-location">📍 {meeting.location}</p>
        )}
        {meeting.attendees && meeting.attendees.length > 0 && (
          <p className="meeting-attendees-count">
            {meeting.attendees.length} attendee{meeting.attendees.length !== 1 ? 's' : ''}
          </p>
        )}
      </div>
    </div>
  );
});

MeetingItem.displayName = 'MeetingItem';

export const MeetingList: React.FC<MeetingListProps> = ({
  meetings,
  onMeetingSelect,
  selectedMeeting,
}) => {
  if (meetings.length === 0) {
    return (
      <div className="no-meetings">
        <p>No meetings scheduled for this day</p>
      </div>
    );
  }

  return (
    <div className="meeting-list">
      {meetings.map((meeting) => (
        <MeetingItem
          key={meeting.id}
          meeting={meeting}
          isSelected={selectedMeeting?.id === meeting.id}
          onSelect={() => onMeetingSelect(meeting)}
        />
      ))}
    </div>
  );
};

