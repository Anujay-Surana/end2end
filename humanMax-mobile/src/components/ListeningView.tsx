import { useState, useEffect } from 'react';
import type { Meeting } from '../types';
import './ListeningView.css';

interface ListeningViewProps {
  meeting: Meeting;
  onClose: () => void;
}

export const ListeningView: React.FC<ListeningViewProps> = ({
  meeting,
  onClose,
}) => {
  const [elapsedTime, setElapsedTime] = useState(0);
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    // Start a timer to show elapsed time
    const interval = setInterval(() => {
      if (isActive) {
        setElapsedTime((prev) => prev + 1);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [isActive]);

  const formatElapsedTime = (seconds: number): string => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleEndSession = () => {
    setIsActive(false);
    onClose();
  };

  return (
    <div className="listening-view">
      <div className="listening-header">
        <div className="listening-meeting-info">
          <h2 className="listening-meeting-title">
            {meeting.summary || 'Meeting'}
          </h2>
          <span className="listening-status-badge">
            <span className="listening-status-dot"></span>
            Listening
          </span>
        </div>
      </div>

      <div className="listening-content">
        {/* Aura Ball */}
        <div className="listening-aura-container">
          <div className="listening-aura-ball">
            <div className="listening-aura-ring listening-aura-ring-1"></div>
            <div className="listening-aura-ring listening-aura-ring-2"></div>
            <div className="listening-aura-ring listening-aura-ring-3"></div>
            <div className="listening-aura-core"></div>
          </div>
        </div>

        {/* Status Text */}
        <div className="listening-status-text">
          <h3>Listening to your meeting</h3>
          <p className="listening-elapsed">{formatElapsedTime(elapsedTime)}</p>
          <p className="listening-hint">
            Shadow is capturing key moments and insights
          </p>
        </div>
      </div>

      <div className="listening-footer">
        <button className="listening-end-button" onClick={handleEndSession}>
          End Session
        </button>
      </div>
    </div>
  );
};

