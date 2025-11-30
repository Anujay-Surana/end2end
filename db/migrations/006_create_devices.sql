-- Create devices table
-- Stores APNs device tokens for push notifications

CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_token TEXT NOT NULL UNIQUE, -- APNs device token
    platform VARCHAR(20) NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios', 'android')),
    timezone VARCHAR(50) NOT NULL DEFAULT 'UTC', -- Device timezone (e.g., 'America/New_York')
    device_info JSONB DEFAULT '{}', -- Store device model, OS version, etc.
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_active_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(device_token);
CREATE INDEX IF NOT EXISTS idx_devices_user_active ON devices(user_id, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_platform ON devices(platform);

-- Add updated_at trigger
CREATE TRIGGER update_devices_updated_at BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

