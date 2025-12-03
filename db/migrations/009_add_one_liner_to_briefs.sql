-- Add one_liner_summary and meeting_date columns to meeting_briefs table
-- Supports pre-generated briefs with quick summaries

-- Add one_liner_summary column
ALTER TABLE meeting_briefs ADD COLUMN IF NOT EXISTS one_liner_summary TEXT;

-- Add meeting_date column for efficient date-based queries
ALTER TABLE meeting_briefs ADD COLUMN IF NOT EXISTS meeting_date DATE;

-- Create index for date-based lookups (user + date)
CREATE INDEX IF NOT EXISTS idx_meeting_briefs_user_date ON meeting_briefs(user_id, meeting_date);

-- Create index for meeting_date alone for queries across all users
CREATE INDEX IF NOT EXISTS idx_meeting_briefs_date ON meeting_briefs(meeting_date);
