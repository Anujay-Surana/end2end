import { useState } from 'react';
import { apiClient } from '../services/apiClient';
import type { Meeting, MeetingPrep as MeetingPrepType } from '../types';
import { VoicePrep } from './VoicePrep';
import './MeetingPrep.css';

interface MeetingPrepProps {
  meeting: Meeting;
  onClose: () => void;
}

export const MeetingPrep: React.FC<MeetingPrepProps> = ({ meeting, onClose }) => {
  const [prep, setPrep] = useState<MeetingPrepType | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showVoicePrep, setShowVoicePrep] = useState(false);
  const [brief, setBrief] = useState<any>(null);

  const generatePrep = async () => {
    setLoading(true);
    setError(null);
    try {
      const attendees = meeting.attendees || [];
      const response = await apiClient.prepMeeting(meeting, attendees);
      
      // Backend returns brief directly, not wrapped in { success, prep }
      // Transform backend response to match MeetingPrep type
      const brief = (response as any).prep || response;
      
      // Convert backend brief structure to MeetingPrep format
      const transformedPrep: MeetingPrepType = {
        meetingTitle: meeting.summary || meeting.title || 'Meeting',
        meetingDate: meeting.start?.dateTime || meeting.start?.date || new Date().toISOString(),
        summary: brief.summary || '',
        sections: [
          ...(brief.attendees && brief.attendees.length > 0 ? [{
            title: 'Attendees',
            content: brief.attendees.map((a: any) => 
              `• ${a.name || a.displayName || a.email}${a.title ? ` - ${a.title}` : ''}${a.company ? ` (${a.company})` : ''}`
            ).join('<br/>')
          }] : []),
          ...(brief.companies && brief.companies.length > 0 ? [{
            title: 'Companies',
            content: brief.companies.map((c: any) => 
              `• ${c.name}${c.description ? `: ${c.description}` : ''}`
            ).join('<br/>')
          }] : []),
          ...(brief.actionItems && brief.actionItems.length > 0 ? [{
            title: 'Action Items',
            content: brief.actionItems.map((item: any) => 
              `• ${typeof item === 'string' ? item : (item.text || item.description || JSON.stringify(item))}`
            ).join('<br/>')
          }] : []),
          // Skip context - it's usually redundant with other sections and often contains raw data dumps
          ...(brief.emailAnalysis ? [{
            title: 'Email Analysis',
            content: brief.emailAnalysis
          }] : []),
          ...(brief.documentAnalysis ? [{
            title: 'Document Analysis',
            content: brief.documentAnalysis
          }] : []),
          ...(brief.relationshipAnalysis ? [{
            title: 'Relationship Analysis',
            content: brief.relationshipAnalysis
          }] : []),
          ...(brief.timeline && brief.timeline.length > 0 ? [{
            title: 'Timeline',
            content: brief.timeline.map((event: any) => 
              `• ${event.date || ''}: ${typeof event === 'string' ? event : (event.description || event.text || JSON.stringify(event))}`
            ).join('<br/>')
          }] : []),
          ...(brief.recommendations && brief.recommendations.length > 0 ? [{
            title: 'Recommendations',
            content: brief.recommendations.map((rec: any) => 
              `• ${typeof rec === 'string' ? rec : (rec.text || rec.description || JSON.stringify(rec))}`
            ).join('<br/>')
          }] : []),
        ]
      };
      
      setPrep(transformedPrep);
      // Store brief for voice prep
      setBrief(brief);
    } catch (err: any) {
      console.error('Prep generation error:', err);
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
            <div className="prep-actions">
              <button 
                className="voice-prep-button" 
                onClick={() => setShowVoicePrep(true)}
                disabled={!brief}
              >
                🎙️ Voice Prep Mode
              </button>
            </div>
            
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
      
      {showVoicePrep && brief && (
        <VoicePrep 
          meeting={meeting} 
          brief={brief}
          onClose={() => setShowVoicePrep(false)} 
        />
      )}
    </div>
  );
};

