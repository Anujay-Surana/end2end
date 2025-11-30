-- Create meeting_briefs table
-- Stores pre-generated briefs for meetings

CREATE TABLE IF NOT EXISTS meeting_briefs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    meeting_id VARCHAR(255) NOT NULL, -- Google Calendar event ID
    brief_data JSONB NOT NULL, -- Full brief object stored as JSON
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, meeting_id)
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_meeting_briefs_user ON meeting_briefs(user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_briefs_meeting ON meeting_briefs(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_briefs_user_meeting ON meeting_briefs(user_id, meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_briefs_created ON meeting_briefs(created_at);

-- Add updated_at trigger
CREATE TRIGGER update_meeting_briefs_updated_at BEFORE UPDATE ON meeting_briefs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

