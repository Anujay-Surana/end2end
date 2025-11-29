"""
Credential Types

Constants and types for different credential types
"""

from enum import Enum
from typing import Dict, Any


class CredentialType(str, Enum):
    """Types of credentials that can be stored"""
    OAUTH_TOKEN = 'oauth_token'  # OAuth access/refresh tokens
    API_KEY = 'api_key'  # API keys (OpenAI, Parallel AI, etc.)
    SERVICE_ACCOUNT = 'service_account'  # Service account JSON
    WEBHOOK_SECRET = 'webhook_secret'  # Webhook signing secrets
    BASIC_AUTH = 'basic_auth'  # Username/password
    SSH_KEY = 'ssh_key'  # SSH private keys


class CredentialProvider(str, Enum):
    """Credential providers"""
    GOOGLE = 'google'
    MICROSOFT = 'microsoft'
    OPENAI = 'openai'
    PARALLEL = 'parallel'
    DEEPGRAM = 'deepgram'
    SUPABASE = 'supabase'
    CUSTOM = 'custom'


def get_credential_metadata(
    credential_type: CredentialType,
    provider: CredentialProvider
) -> Dict[str, Any]:
    """
    Get metadata about a credential type/provider combination
    Args:
        credential_type: Type of credential
        provider: Provider name
    Returns:
        Metadata dict with fields, validation rules, etc.
    """
    metadata = {
        'type': credential_type.value,
        'provider': provider.value,
        'fields': [],
        'encrypted': True,  # Default to encrypted storage
        'rotation_supported': False
    }
    
    if credential_type == CredentialType.OAUTH_TOKEN:
        metadata['fields'] = ['access_token', 'refresh_token', 'token_expires_at', 'scopes']
        metadata['rotation_supported'] = True
    elif credential_type == CredentialType.API_KEY:
        metadata['fields'] = ['api_key', 'name', 'description']
        metadata['encrypted'] = True
    elif credential_type == CredentialType.SERVICE_ACCOUNT:
        metadata['fields'] = ['service_account_json', 'project_id']
        metadata['encrypted'] = True
    elif credential_type == CredentialType.WEBHOOK_SECRET:
        metadata['fields'] = ['secret', 'algorithm']
        metadata['encrypted'] = True
    
    return metadata

