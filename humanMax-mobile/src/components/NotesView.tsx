import { useState } from 'react';
import type { MeetingNote } from '../types';
import './NotesView.css';

// Mock data for demonstration - will be populated from listened meetings later
const mockNotes: MeetingNote[] = [
  {
    id: 'note-1',
    meetingId: 'meeting-1',
    meeting: {
      id: 'meeting-1',
      summary: 'Q4 Planning Session',
      start: { dateTime: '2024-12-03T10:00:00' },
      end: { dateTime: '2024-12-03T11:30:00' },
      attendees: [
        { email: 'john@example.com', displayName: 'John Smith' },
        { email: 'sarah@example.com', displayName: 'Sarah Johnson' },
      ],
    },
    listenedAt: '2024-12-03T11:30:00',
    notes: [
      'Discussed Q4 targets and KPIs',
      'Sarah proposed new marketing strategy',
      'Budget allocation needs review by Friday',
      'Next steps: Schedule follow-up with finance team',
    ],
  },
  {
    id: 'note-2',
    meetingId: 'meeting-2',
    meeting: {
      id: 'meeting-2',
      summary: 'Product Roadmap Review',
      start: { dateTime: '2024-12-02T14:00:00' },
      end: { dateTime: '2024-12-02T15:00:00' },
      attendees: [
        { email: 'mike@example.com', displayName: 'Mike Brown' },
        { email: 'lisa@example.com', displayName: 'Lisa Chen' },
        { email: 'david@example.com', displayName: 'David Wilson' },
      ],
    },
    listenedAt: '2024-12-02T15:00:00',
    notes: [
      'Feature prioritization for Q1 2025',
      'Mobile app redesign timeline confirmed',
      'API v2 launch scheduled for January',
      'Action item: Create technical spec document',
    ],
  },
  {
    id: 'note-3',
    meetingId: 'meeting-3',
    meeting: {
      id: 'meeting-3',
      summary: 'Client Onboarding Call',
      start: { dateTime: '2024-12-01T09:00:00' },
      end: { dateTime: '2024-12-01T09:45:00' },
      attendees: [
        { email: 'client@acme.com', displayName: 'James from Acme Corp' },
      ],
    },
    listenedAt: '2024-12-01T09:45:00',
    notes: [
      'Client interested in enterprise plan',
      'Main pain point: current tool lacks integration',
      'Demo scheduled for next week',
      'Send pricing proposal by Thursday',
    ],
  },
];

interface NoteDetailModalProps {
  note: MeetingNote;
  onClose: () => void;
}

const NoteDetailModal: React.FC<NoteDetailModalProps> = ({ note, onClose }) => {
  const formatDateTime = (dateTime: string): string => {
    try {
      const dt = new Date(dateTime);
      return dt.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return dateTime;
    }
  };

  const attendees = note.meeting.attendees || [];

  return (
    <div className="note-detail-overlay" onClick={onClose}>
      <div className="note-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="note-detail-header">
          <button className="note-detail-close" onClick={onClose}>
            ←
          </button>
          <span className="note-detail-header-title">Meeting Notes</span>
        </div>

        <div className="note-detail-content">
          <h1 className="note-detail-title">{note.meeting.summary}</h1>

          <div className="note-detail-meta">
            <div className="note-detail-meta-item">
              <span className="note-detail-meta-icon">🕐</span>
              <span>{formatDateTime(note.meeting.start?.dateTime || '')}</span>
            </div>
            {attendees.length > 0 && (
              <div className="note-detail-meta-item">
                <span className="note-detail-meta-icon">👥</span>
                <span>
                  {attendees
                    .slice(0, 3)
                    .map((a) => a.displayName || a.email)
                    .join(', ')}
                  {attendees.length > 3 && ` +${attendees.length - 3} more`}
                </span>
              </div>
            )}
          </div>

          <div className="note-detail-section">
            <h3 className="note-detail-section-title">In-Meeting Notes</h3>
            <ul className="note-detail-notes-list">
              {note.notes.map((noteText, idx) => (
                <li key={idx} className="note-detail-note-item">
                  {noteText}
                </li>
              ))}
            </ul>
          </div>

          <div className="note-detail-recorded">
            <span className="note-detail-recorded-icon">✓</span>
            Recorded on {formatDateTime(note.listenedAt)}
          </div>
        </div>
      </div>
    </div>
  );
};

export const NotesView: React.FC = () => {
  const [notes] = useState<MeetingNote[]>(mockNotes);
  const [selectedNote, setSelectedNote] = useState<MeetingNote | null>(null);

  const groupNotesByDate = (notes: MeetingNote[]): Map<string, MeetingNote[]> => {
    const groups = new Map<string, MeetingNote[]>();
    
    notes.forEach((note) => {
      const dateStr = note.listenedAt.split('T')[0];
      const existing = groups.get(dateStr) || [];
      groups.set(dateStr, [...existing, note]);
    });

    return groups;
  };

  const formatDateHeader = (dateStr: string): string => {
    try {
      const date = new Date(dateStr);
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      if (date.toDateString() === today.toDateString()) {
        return 'Today';
      }
      if (date.toDateString() === yesterday.toDateString()) {
        return 'Yesterday';
      }

      return date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  const formatTime = (dateTime: string): string => {
    try {
      const dt = new Date(dateTime);
      return dt.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return '';
    }
  };

  const groupedNotes = groupNotesByDate(notes);
  const sortedDates = Array.from(groupedNotes.keys()).sort((a, b) => 
    new Date(b).getTime() - new Date(a).getTime()
  );

  return (
    <div className="notes-view">
      <div className="notes-header">
        <h1 className="notes-title">Notes</h1>
        <p className="notes-subtitle">Meeting recordings & insights</p>
      </div>

      <div className="notes-content">
        {notes.length === 0 ? (
          <div className="notes-empty">
            <div className="notes-empty-icon">📝</div>
            <h3>No notes yet</h3>
            <p>Notes from your listened meetings will appear here</p>
          </div>
        ) : (
          <div className="notes-timeline">
            {sortedDates.map((dateStr) => (
              <div key={dateStr} className="notes-timeline-group">
                <div className="notes-timeline-date">
                  <span className="notes-timeline-date-text">
                    {formatDateHeader(dateStr)}
                  </span>
                </div>

                <div className="notes-timeline-items">
                  {groupedNotes.get(dateStr)?.map((note) => (
                    <div
                      key={note.id}
                      className="notes-timeline-item"
                      onClick={() => setSelectedNote(note)}
                    >
                      <div className="notes-timeline-dot"></div>
                      <div className="notes-timeline-card">
                        <div className="notes-timeline-card-time">
                          {formatTime(note.meeting.start?.dateTime || '')}
                        </div>
                        <h3 className="notes-timeline-card-title">
                          {note.meeting.summary}
                        </h3>
                        <p className="notes-timeline-card-preview">
                          {note.notes[0]}
                        </p>
                        <div className="notes-timeline-card-meta">
                          <span>{note.notes.length} notes captured</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedNote && (
        <NoteDetailModal
          note={selectedNote}
          onClose={() => setSelectedNote(null)}
        />
      )}
    </div>
  );
};

