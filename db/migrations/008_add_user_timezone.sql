-- Add timezone column to users table
-- Stores user's timezone for timezone-aware scheduling

ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) NOT NULL DEFAULT 'UTC';

-- Create index for timezone queries
CREATE INDEX IF NOT EXISTS idx_users_timezone ON users(timezone);

-- Update existing users to UTC if they don't have a timezone set
UPDATE users SET timezone = 'UTC' WHERE timezone IS NULL;

