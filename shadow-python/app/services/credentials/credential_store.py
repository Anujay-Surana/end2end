"""
Credential Store

Unified credential storage and retrieval
Supports OAuth tokens, API keys, service accounts, etc.
"""

import json
import base64
from typing import Dict, Any, List, Optional
from datetime import datetime
from app.db.connection import supabase
from app.services.credentials.credential_types import CredentialType, CredentialProvider, get_credential_metadata
from app.services.logger import logger


def _encrypt_credential_data(data: Dict[str, Any]) -> str:
    """
    Encrypt credential data (simple base64 encoding for now)
    In production, use proper encryption (AES-256-GCM)
    Args:
        data: Credential data dict
    Returns:
        Encrypted/encoded string
    """
    # TODO: Implement proper encryption
    # For now, base64 encode (NOT secure, but better than plaintext)
    json_str = json.dumps(data)
    return base64.b64encode(json_str.encode('utf-8')).decode('utf-8')


def _decrypt_credential_data(encrypted_data: str) -> Dict[str, Any]:
    """
    Decrypt credential data
    Args:
        encrypted_data: Encrypted/encoded string
    Returns:
        Decrypted credential data dict
    """
    # TODO: Implement proper decryption
    # For now, base64 decode
    json_str = base64.b64decode(encrypted_data.encode('utf-8')).decode('utf-8')
    return json.loads(json_str)


async def store_credential(
    user_id: str,
    provider: str,
    credential_type: str,
    credential_data: Dict[str, Any],
    name: Optional[str] = None,
    expires_at: Optional[datetime] = None
) -> Dict[str, Any]:
    """
    Store a credential for a user
    Args:
        user_id: User UUID
        provider: Provider name (google, openai, etc.)
        credential_type: Type of credential (oauth_token, api_key, etc.)
        credential_data: Credential data dict
        name: Optional name/description for the credential
        expires_at: Optional expiration date
    Returns:
        Stored credential object
    """
    metadata = get_credential_metadata(
        CredentialType(credential_type),
        CredentialProvider(provider)
    )
    
    # Encrypt sensitive data
    encrypted_data = _encrypt_credential_data(credential_data)
    
    # Check if credential already exists (upsert)
    existing = await get_credential(user_id, provider, credential_type)
    
    if existing:
        # Update existing credential
        response = supabase.table('service_credentials').update({
            'credential_data': encrypted_data,
            'name': name or existing.get('name'),
            'is_active': True,
            'expires_at': expires_at.isoformat() if expires_at else None,
            'updated_at': datetime.utcnow().isoformat()
        }).eq('id', existing['id']).select().execute()
    else:
        # Create new credential
        response = supabase.table('service_credentials').insert({
            'user_id': user_id,
            'provider': provider,
            'credential_type': credential_type,
            'credential_data': encrypted_data,
            'name': name or f'{provider} {credential_type}',
            'is_active': True,
            'expires_at': expires_at.isoformat() if expires_at else None
        }).select().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to store credential: {response.error.message}')
    if response.data and len(response.data) > 0:
        logger.info(
            f'Credential stored',
            userId=user_id,
            provider=provider,
            credentialType=credential_type
        )
        return response.data[0]
    raise Exception('Failed to store credential')


async def get_credential(
    user_id: str,
    provider: str,
    credential_type: str
) -> Optional[Dict[str, Any]]:
    """
    Get a credential for a user
    Args:
        user_id: User UUID
        provider: Provider name
        credential_type: Type of credential
    Returns:
        Credential object with decrypted data or None
    """
    response = supabase.table('service_credentials').select('*').eq(
        'user_id', user_id
    ).eq('provider', provider).eq(
        'credential_type', credential_type
    ).eq('is_active', True).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    
    if not response.data:
        return None
    
    credential = response.data
    
    # Check expiration
    if credential.get('expires_at'):
        expires_at = datetime.fromisoformat(credential['expires_at'].replace('Z', '+00:00'))
        if datetime.utcnow() > expires_at.replace(tzinfo=None):
            logger.warning(f'Credential expired: {provider}/{credential_type}')
            return None
    
    # Decrypt credential data
    try:
        credential['credential_data'] = _decrypt_credential_data(credential['credential_data'])
    except Exception as e:
        logger.error(f'Failed to decrypt credential: {str(e)}')
        return None
    
    return credential


async def get_all_user_credentials(
    user_id: str,
    provider: Optional[str] = None,
    credential_type: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Get all credentials for a user (optionally filtered)
    Args:
        user_id: User UUID
        provider: Optional provider filter
        credential_type: Optional credential type filter
    Returns:
        List of credential objects with decrypted data
    """
    query = supabase.table('service_credentials').select('*').eq('user_id', user_id).eq('is_active', True)
    
    if provider:
        query = query.eq('provider', provider)
    if credential_type:
        query = query.eq('credential_type', credential_type)
    
    response = query.execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    
    credentials = response.data or []
    
    # Decrypt all credentials
    result = []
    for cred in credentials:
        # Check expiration
        if cred.get('expires_at'):
            expires_at = datetime.fromisoformat(cred['expires_at'].replace('Z', '+00:00'))
            if datetime.utcnow() > expires_at.replace(tzinfo=None):
                continue
        
        try:
            cred['credential_data'] = _decrypt_credential_data(cred['credential_data'])
            result.append(cred)
        except Exception as e:
            logger.error(f'Failed to decrypt credential {cred.get("id")}: {str(e)}')
            continue
    
    return result


async def revoke_credential(
    credential_id: str
) -> bool:
    """
    Revoke/deactivate a credential
    Args:
        credential_id: Credential UUID
    Returns:
        Success status
    """
    response = supabase.table('service_credentials').update({
        'is_active': False,
        'updated_at': datetime.utcnow().isoformat()
    }).eq('id', credential_id).select('id').execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to revoke credential: {response.error.message}')
    
    success = response.data is not None and len(response.data) > 0
    if success:
        logger.info(f'Credential revoked: {credential_id}')
    return success


async def delete_credential(
    credential_id: str
) -> bool:
    """
    Permanently delete a credential
    Args:
        credential_id: Credential UUID
    Returns:
        Success status
    """
    response = supabase.table('service_credentials').delete().eq('id', credential_id).select('id').execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to delete credential: {response.error.message}')
    
    success = response.data is not None and len(response.data) > 0
    if success:
        logger.info(f'Credential deleted: {credential_id}')
    return success

