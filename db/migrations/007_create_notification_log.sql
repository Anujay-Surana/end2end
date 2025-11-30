-- Create notification_log table
-- Tracks sent push notifications for auditing and debugging

CREATE TABLE IF NOT EXISTS notification_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
    notification_type VARCHAR(50) NOT NULL CHECK (notification_type IN ('daily_summary', 'meeting_reminder', 'brief_ready', 'custom')),
    meeting_id VARCHAR(255), -- Optional: link to specific meeting
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data JSONB DEFAULT '{}', -- Additional notification payload data
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'delivered')),
    error_message TEXT, -- Store error details if status is 'failed'
    sent_at TIMESTAMP, -- When notification was actually sent
    created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_notification_log_user ON notification_log(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_device ON notification_log(device_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_type ON notification_log(notification_type);
CREATE INDEX IF NOT EXISTS idx_notification_log_status ON notification_log(status);
CREATE INDEX IF NOT EXISTS idx_notification_log_meeting ON notification_log(meeting_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_created ON notification_log(created_at);
CREATE INDEX IF NOT EXISTS idx_notification_log_user_created ON notification_log(user_id, created_at DESC);

