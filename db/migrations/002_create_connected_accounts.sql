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
CREATE OR REPLACE FUNCTION ensure_single_primary_account()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_primary = true THEN
        -- Set all other accounts for this user to non-primary
        UPDATE connected_accounts
        SET is_primary = false
        WHERE user_id = NEW.user_id
        AND id != NEW.id;
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER enforce_single_primary_account BEFORE INSERT OR UPDATE ON connected_accounts
    FOR EACH ROW EXECUTE FUNCTION ensure_single_primary_account();
