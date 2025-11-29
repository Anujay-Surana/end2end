"""
Credential Validator

Validates credentials before use (test API keys, verify OAuth tokens, etc.)
"""

import httpx
from typing import Dict, Any, Optional
from app.services.credentials.credential_types import CredentialType, CredentialProvider
from app.services.logger import logger


async def validate_oauth_token(
    provider: str,
    access_token: str
) -> Dict[str, Any]:
    """
    Validate OAuth access token by making a test API call
    Args:
        provider: Provider name (google, microsoft, etc.)
        access_token: Access token to validate
    Returns:
        Validation result with isValid, userInfo, etc.
    """
    if provider == 'google':
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    'https://www.googleapis.com/oauth2/v2/userinfo',
                    headers={'Authorization': f'Bearer {access_token}'},
                    timeout=10.0
                )
            
            if response.is_success:
                user_info = response.json()
                return {
                    'isValid': True,
                    'userInfo': {
                        'email': user_info.get('email'),
                        'name': user_info.get('name'),
                        'picture': user_info.get('picture')
                    }
                }
            else:
                return {
                    'isValid': False,
                    'error': f'HTTP {response.status_code}',
                    'errorDescription': response.text[:200]
                }
        except Exception as e:
            logger.error(f'Failed to validate Google OAuth token: {str(e)}')
            return {
                'isValid': False,
                'error': str(e)
            }
    else:
        return {
            'isValid': False,
            'error': f'Unsupported provider: {provider}'
        }


async def validate_api_key(
    provider: str,
    api_key: str
) -> Dict[str, Any]:
    """
    Validate API key by making a test API call
    Args:
        provider: Provider name (openai, parallel, etc.)
        api_key: API key to validate
    Returns:
        Validation result with isValid, accountInfo, etc.
    """
    if provider == 'openai':
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    'https://api.openai.com/v1/models',
                    headers={'Authorization': f'Bearer {api_key}'},
                    timeout=10.0
                )
            
            if response.is_success:
                return {
                    'isValid': True,
                    'accountInfo': {
                        'provider': 'openai',
                        'hasAccess': True
                    }
                }
            elif response.status_code == 401:
                return {
                    'isValid': False,
                    'error': 'Invalid API key'
                }
            else:
                return {
                    'isValid': False,
                    'error': f'HTTP {response.status_code}'
                }
        except Exception as e:
            logger.error(f'Failed to validate OpenAI API key: {str(e)}')
            return {
                'isValid': False,
                'error': str(e)
            }
    
    elif provider == 'parallel':
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    'https://api.parallel.ai/v1/account',
                    headers={'Authorization': f'Bearer {api_key}'},
                    timeout=10.0
                )
            
            if response.is_success:
                account_info = response.json()
                return {
                    'isValid': True,
                    'accountInfo': account_info
                }
            elif response.status_code == 401:
                return {
                    'isValid': False,
                    'error': 'Invalid API key'
                }
            else:
                return {
                    'isValid': False,
                    'error': f'HTTP {response.status_code}'
                }
        except Exception as e:
            logger.error(f'Failed to validate Parallel API key: {str(e)}')
            return {
                'isValid': False,
                'error': str(e)
            }
    
    else:
        return {
            'isValid': False,
            'error': f'Unsupported provider: {provider}'
        }


async def validate_credential(
    credential_type: str,
    provider: str,
    credential_data: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Validate a credential based on its type
    Args:
        credential_type: Type of credential
        provider: Provider name
        credential_data: Credential data dict
    Returns:
        Validation result
    """
    if credential_type == CredentialType.OAUTH_TOKEN.value:
        access_token = credential_data.get('access_token')
        if not access_token:
            return {'isValid': False, 'error': 'No access_token in credential data'}
        return await validate_oauth_token(provider, access_token)
    
    elif credential_type == CredentialType.API_KEY.value:
        api_key = credential_data.get('api_key') or credential_data.get('apiKey')
        if not api_key:
            return {'isValid': False, 'error': 'No API key in credential data'}
        return await validate_api_key(provider, api_key)
    
    else:
        # For other types, assume valid (can't easily test)
        return {
            'isValid': True,
            'note': f'Credential type {credential_type} validation not implemented'
        }

