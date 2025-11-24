-- Create users table
-- Stores primary user identity

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    picture_url TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create index on email for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
-- Create connected_accounts table
-- Stores multiple Google accounts per user (1:N relationship)

CREATE TABLE IF NOT EXISTS connected_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL DEFAULT 'google',
    account_email VARCHAR(255) NOT NULL,
    account_name VARCHAR(255),
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_expires_at TIMESTAMP,
    scopes TEXT[], -- Array of granted OAuth scopes
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, account_email)
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_connected_accounts_user ON connected_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_email ON connected_accounts(account_email);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_primary ON connected_accounts(user_id, is_primary) WHERE is_primary = true;

-- Add updated_at trigger
CREATE TRIGGER update_connected_accounts_updated_at BEFORE UPDATE ON connected_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Ensure only one primary account per user
-- Updated to avoid constraint violations during upsert operations
CREATE OR REPLACE FUNCTION ensure_single_primary_account()
RETURNS TRIGGER AS $$
BEGIN
    -- Only update other accounts if:
    -- 1. NEW.is_primary is true (user is setting this account as primary)
    -- 2. AND either this is an INSERT or is_primary is changing from false to true
    IF NEW.is_primary = true AND (TG_OP = 'INSERT' OR OLD.is_primary = false OR OLD.is_primary IS NULL) THEN
        -- Set all other accounts for this user to non-primary
        -- Only update rows that are currently set as primary (avoid unnecessary updates)
        UPDATE connected_accounts
        SET is_primary = false,
            updated_at = NOW()
        WHERE user_id = NEW.user_id
        AND id != NEW.id
        AND is_primary = true;  -- Only update if currently primary
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_single_primary_account BEFORE INSERT OR UPDATE ON connected_accounts
    FOR EACH ROW EXECUTE FUNCTION ensure_single_primary_account();
-- Create sessions table
-- Stores server-side sessions for authenticated users

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for efficient session lookups
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Function to clean up expired sessions
CREATE OR REPLACE FUNCTION delete_expired_sessions()
RETURNS void AS $$
BEGIN
    DELETE FROM sessions WHERE expires_at < NOW();
END;
$$ language 'plpgsql';

-- Note: In production, run this function periodically with a cron job or scheduled task
-- Example: SELECT delete_expired_sessions();
