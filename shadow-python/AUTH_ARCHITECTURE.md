# Authentication Architecture Documentation

## Overview

This document describes the enhanced authentication architecture implemented for onboarding flows and microservices support.

## Architecture Components

### 1. Modular OAuth Service (`app/services/oauth/`)

**Purpose**: Provides a modular, extensible OAuth implementation supporting multiple providers.

**Key Files**:
- `oauth_provider.py` - Abstract base class for OAuth providers
- `google_oauth.py` - Google OAuth 2.0 implementation
- `oauth_manager.py` - High-level OAuth operations and state management

**Features**:
- Provider abstraction (easy to add Microsoft, etc.)
- OAuth state management (CSRF protection)
- Token exchange and refresh
- Token revocation

**Usage**:
```python
from app.services.oauth.oauth_manager import OAuthManager

oauth_manager = OAuthManager()

# Initiate OAuth flow
result = oauth_manager.initiate_oauth(
    provider_name='google',
    redirect_uri='postmessage',
    scopes=['openid', 'email', 'profile'],
    user_id=user_id
)

# Exchange code for tokens
tokens = await oauth_manager.exchange_code(
    provider_name='google',
    code=code,
    redirect_uri=redirect_uri,
    state=state
)
```

### 2. Credential Management Service (`app/services/credentials/`)

**Purpose**: Unified storage and management for all credential types (OAuth tokens, API keys, service accounts, etc.).

**Key Files**:
- `credential_types.py` - Credential type definitions and metadata
- `credential_store.py` - Credential storage and retrieval
- `credential_validator.py` - Credential validation before use

**Supported Credential Types**:
- `oauth_token` - OAuth access/refresh tokens
- `api_key` - API keys (OpenAI, Parallel AI, etc.)
- `service_account` - Service account JSON
- `webhook_secret` - Webhook signing secrets
- `basic_auth` - Username/password
- `ssh_key` - SSH private keys

**Usage**:
```python
from app.services.credentials.credential_store import store_credential, get_credential

# Store an API key
await store_credential(
    user_id=user_id,
    provider='openai',
    credential_type='api_key',
    credential_data={'api_key': 'sk-...'},
    name='OpenAI API Key'
)

# Retrieve credential
credential = await get_credential(
    user_id=user_id,
    provider='openai',
    credential_type='api_key'
)
```

### 3. Onboarding Flow Service (`app/services/onboarding/`)

**Purpose**: Manages step-by-step user onboarding with progress tracking.

**Key Files**:
- `onboarding_state.py` - Onboarding state persistence
- `onboarding_manager.py` - High-level onboarding operations

**Onboarding Steps**:
1. `welcome` - Welcome screen
2. `connect_google` - Connect primary Google account
3. `grant_calendar` - Grant calendar access
4. `grant_gmail` - Grant Gmail access
5. `grant_drive` - Grant Drive access
6. `connect_additional_accounts` - Add more accounts (optional)
7. `setup_preferences` - Configure preferences (optional)

**Usage**:
```python
from app.services.onboarding.onboarding_manager import OnboardingManager

manager = OnboardingManager()

# Get onboarding status
status = await manager.get_onboarding_status(user_id)

# Complete a step
await manager.complete_step(user_id, 'connect_google', {'accountEmail': 'user@example.com'})
```

### 4. Progressive Permission Requests

**Purpose**: Request OAuth scopes incrementally instead of all at once.

**Implementation**: 
- `POST /auth/google/request-scopes` - Request additional scopes for existing account
- Tracks granted vs requested scopes per account
- Forces re-authentication with `prompt=consent` to get new scopes

**Usage**:
```python
# Request additional scopes
POST /auth/google/request-scopes
{
  "scopes": ["https://www.googleapis.com/auth/calendar.readonly"],
  "account_id": "optional-account-id"
}
```

### 5. Microservices Authentication (`app/services/auth/`)

**Purpose**: JWT-based service-to-service authentication.

**Key Files**:
- `jwt_service.py` - JWT token generation and validation
- `middleware/service_auth.py` - Service token validation middleware

**Features**:
- JWT tokens for stateless service authentication
- Scope-based permissions
- Token expiration

**Usage**:
```python
from app.services.auth.jwt_service import generate_service_token, validate_service_token

# Generate service token
token = generate_service_token(
    user_id=user_id,
    service_name='meeting-prep-service',
    scopes=['read:meetings', 'write:briefs']
)

# Validate token
payload = validate_service_token(token)
```

**Middleware Usage**:
```python
from app.middleware.service_auth import validate_service_token_middleware, require_scope

@router.get('/protected')
async def protected_endpoint(
    token_payload: Dict = Depends(validate_service_token_middleware)
):
    # Token validated, use token_payload['user_id']
    pass

@router.post('/write')
async def write_endpoint(
    token_payload: Dict = Depends(require_scope('write:briefs'))
):
    # Token validated AND has required scope
    pass
```

## Database Schema

### New Tables

1. **`onboarding_steps`**
   - Tracks completed onboarding steps per user
   - Fields: `user_id`, `step_name`, `completed_at`, `data` (JSONB)

2. **`service_credentials`**
   - Stores encrypted credentials (API keys, service accounts, etc.)
   - Fields: `user_id`, `provider`, `credential_type`, `credential_data` (encrypted), `is_active`, `expires_at`

3. **`oauth_flows`**
   - Tracks OAuth state for CSRF protection
   - Fields: `user_id`, `provider`, `state`, `requested_scopes`, `redirect_uri`, `expires_at`

## API Endpoints

### Onboarding
- `GET /onboarding/status` - Get current onboarding status
- `POST /onboarding/complete-step` - Complete an onboarding step
- `POST /onboarding/skip-step` - Skip an optional step
- `POST /onboarding/reset` - Reset onboarding

### Credentials
- `POST /api-keys` - Store a credential
- `GET /api-keys` - List all credentials
- `GET /api-keys/{provider}/{credential_type}` - Get specific credential
- `POST /api-keys/validate` - Validate credential before storing
- `POST /api-keys/{credential_id}/revoke` - Revoke credential
- `DELETE /api-keys/{credential_id}` - Delete credential

### Service Authentication
- `POST /auth/service-token` - Generate JWT service token

### Enhanced Auth (Progressive Permissions)
- `POST /auth/google/initiate` - Initiate OAuth flow
- `POST /auth/google/request-scopes` - Request additional scopes

## Migration Guide

### For Existing Code

1. **OAuth Flows**: Can continue using existing `routes/auth.py` or migrate to `routes/auth_enhanced.py`
2. **Credential Storage**: Migrate from direct database access to `credential_store` service
3. **Onboarding**: New feature - no migration needed
4. **Service Auth**: New feature - use for new microservices

### Backward Compatibility

- Existing auth routes (`routes/auth.py`) remain functional
- New routes (`routes/auth_enhanced.py`) provide enhanced features
- Both can coexist during migration period

## Security Considerations

1. **Credential Encryption**: Currently uses base64 encoding (TODO: implement proper AES-256-GCM)
2. **JWT Secret**: Must be set via `JWT_SECRET` environment variable
3. **OAuth State**: 10-minute expiration, one-time use
4. **Token Expiration**: Service tokens default to 24 hours
5. **Scope Validation**: Enforced in service auth middleware

## Future Enhancements

1. **Credential Encryption**: Implement proper encryption at rest
2. **Multiple Providers**: Add Microsoft, Slack, etc.
3. **Credential Rotation**: Automatic rotation for expiring credentials
4. **Audit Logging**: Log all credential access
5. **Webhook Validation**: Webhook signature validation service

## Testing

See individual service files for unit test examples. Integration tests should cover:
- Full onboarding flow
- OAuth flow with progressive permissions
- Credential storage and retrieval
- Service token generation and validation

