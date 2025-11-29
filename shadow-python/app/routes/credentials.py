"""
Credentials Routes

Endpoints for managing API keys and other credentials
"""

from typing import Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from datetime import datetime
from app.middleware.auth import require_auth
from app.services.credentials.credential_store import (
    store_credential,
    get_credential,
    get_all_user_credentials,
    revoke_credential,
    delete_credential
)
from app.services.credentials.credential_validator import validate_credential
from app.services.credentials.credential_types import CredentialType, CredentialProvider
from app.services.logger import logger

router = APIRouter()


class StoreCredentialRequest(BaseModel):
    provider: str
    credential_type: str
    credential_data: Dict[str, Any]
    name: Optional[str] = None
    expires_at: Optional[str] = None  # ISO format datetime


class ValidateCredentialRequest(BaseModel):
    provider: str
    credential_type: str
    credential_data: Dict[str, Any]


@router.post('/api-keys')
async def store_api_key(
    request: StoreCredentialRequest,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Store an API key or other credential
    """
    try:
        expires_at = None
        if request.expires_at:
            expires_at = datetime.fromisoformat(request.expires_at.replace('Z', '+00:00'))
        
        credential = await store_credential(
            user_id=user['id'],
            provider=request.provider,
            credential_type=request.credential_type,
            credential_data=request.credential_data,
            name=request.name,
            expires_at=expires_at
        )
        
        return {
            'success': True,
            'credential': {
                'id': credential['id'],
                'provider': credential['provider'],
                'credential_type': credential['credential_type'],
                'name': credential.get('name')
            }
        }
    except Exception as e:
        logger.error(f'Failed to store credential: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/api-keys')
async def list_credentials(
    provider: Optional[str] = None,
    credential_type: Optional[str] = None,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    List all credentials for the current user
    """
    try:
        credentials = await get_all_user_credentials(
            user_id=user['id'],
            provider=provider,
            credential_type=credential_type
        )
        
        # Sanitize credentials (don't expose full credential data)
        sanitized = []
        for cred in credentials:
            sanitized.append({
                'id': cred['id'],
                'provider': cred['provider'],
                'credential_type': cred['credential_type'],
                'name': cred.get('name'),
                'is_active': cred.get('is_active'),
                'expires_at': cred.get('expires_at'),
                'created_at': cred.get('created_at')
            })
        
        return {
            'success': True,
            'credentials': sanitized
        }
    except Exception as e:
        logger.error(f'Failed to list credentials: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/api-keys/{provider}/{credential_type}')
async def get_credential_endpoint(
    provider: str,
    credential_type: str,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Get a specific credential (returns credential data)
    """
    try:
        credential = await get_credential(
            user_id=user['id'],
            provider=provider,
            credential_type=credential_type
        )
        
        if not credential:
            raise HTTPException(status_code=404, detail='Credential not found')
        
        return {
            'success': True,
            'credential': {
                'id': credential['id'],
                'provider': credential['provider'],
                'credential_type': credential['credential_type'],
                'name': credential.get('name'),
                'credential_data': credential.get('credential_data')
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Failed to get credential: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/api-keys/validate')
async def validate_credential_endpoint(
    request: ValidateCredentialRequest,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Validate a credential before storing it
    """
    try:
        result = await validate_credential(
            credential_type=request.credential_type,
            provider=request.provider,
            credential_data=request.credential_data
        )
        
        return {
            'success': True,
            'validation': result
        }
    except Exception as e:
        logger.error(f'Failed to validate credential: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/api-keys/{credential_id}/revoke')
async def revoke_credential_endpoint(
    credential_id: str,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Revoke/deactivate a credential
    """
    try:
        # Verify credential belongs to user
        credentials = await get_all_user_credentials(user_id=user['id'])
        credential_ids = [c['id'] for c in credentials]
        
        if credential_id not in credential_ids:
            raise HTTPException(status_code=404, detail='Credential not found')
        
        success = await revoke_credential(credential_id)
        
        return {
            'success': success,
            'message': 'Credential revoked' if success else 'Failed to revoke credential'
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Failed to revoke credential: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=str(e))


@router.delete('/api-keys/{credential_id}')
async def delete_credential_endpoint(
    credential_id: str,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Permanently delete a credential
    """
    try:
        # Verify credential belongs to user
        credentials = await get_all_user_credentials(user_id=user['id'])
        credential_ids = [c['id'] for c in credentials]
        
        if credential_id not in credential_ids:
            raise HTTPException(status_code=404, detail='Credential not found')
        
        success = await delete_credential(credential_id)
        
        return {
            'success': success,
            'message': 'Credential deleted' if success else 'Failed to delete credential'
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Failed to delete credential: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=str(e))

