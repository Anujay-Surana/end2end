-- Migration: Add onboarding and credential management tables
-- Created: 2024-01-XX
-- Description: Adds tables for onboarding state tracking and credential management

-- Onboarding steps table
CREATE TABLE IF NOT EXISTS onboarding_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    step_name VARCHAR(50) NOT NULL,
    completed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    data JSONB DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, step_name)
);

CREATE INDEX IF NOT EXISTS idx_onboarding_steps_user_id ON onboarding_steps(user_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_steps_step_name ON onboarding_steps(step_name);

-- Service credentials table (for API keys, service accounts, etc.)
CREATE TABLE IF NOT EXISTS service_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    credential_type VARCHAR(50) NOT NULL,
    credential_data TEXT NOT NULL, -- Encrypted credential data
    name VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, provider, credential_type)
);

CREATE INDEX IF NOT EXISTS idx_service_credentials_user_id ON service_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_service_credentials_provider ON service_credentials(provider);
CREATE INDEX IF NOT EXISTS idx_service_credentials_type ON service_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_service_credentials_active ON service_credentials(is_active);

-- OAuth flows table (for tracking OAuth state)
CREATE TABLE IF NOT EXISTS oauth_flows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    state VARCHAR(255) NOT NULL UNIQUE,
    requested_scopes TEXT[],
    redirect_uri VARCHAR(500),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_oauth_flows_state ON oauth_flows(state);
CREATE INDEX IF NOT EXISTS idx_oauth_flows_user_id ON oauth_flows(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_flows_expires_at ON oauth_flows(expires_at);

-- Cleanup expired OAuth flows (can be run periodically)
-- DELETE FROM oauth_flows WHERE expires_at < NOW();

