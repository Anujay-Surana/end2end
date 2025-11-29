"""
Google OAuth Provider

Implements Google OAuth 2.0 flow
"""

import httpx
from typing import Dict, Any, List, Optional
from urllib.parse import urlencode
from app.services.oauth.oauth_provider import OAuthProvider
from app.services.logger import logger
from app.config import settings


class GoogleOAuthProvider(OAuthProvider):
    """Google OAuth 2.0 provider implementation"""
    
    def __init__(self):
        self.client_id = settings.GOOGLE_CLIENT_ID
        self.client_secret = settings.GOOGLE_CLIENT_SECRET
        
        if not self.client_id or not self.client_secret:
            raise ValueError('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set')
    
    def get_authorization_url(
        self,
        redirect_uri: str,
        scopes: List[str],
        state: Optional[str] = None,
        prompt: Optional[str] = None
    ) -> str:
        """
        Generate Google OAuth authorization URL
        Args:
            redirect_uri: OAuth redirect URI
            scopes: List of requested scopes
            state: OAuth state parameter (for CSRF protection)
            prompt: Prompt type (consent, select_account, none)
        Returns:
            Authorization URL
        """
        base_url = 'https://accounts.google.com/o/oauth2/v2/auth'
        
        params = {
            'client_id': self.client_id,
            'redirect_uri': redirect_uri,
            'response_type': 'code',
            'scope': ' '.join(scopes),
            'access_type': 'offline',  # Required to get refresh_token
            'prompt': prompt or 'consent'  # Force consent to get refresh_token
        }
        
        if state:
            params['state'] = state
        
        return f'{base_url}?{urlencode(params)}'
    
    async def exchange_code(
        self,
        code: str,
        redirect_uri: str
    ) -> Dict[str, Any]:
        """
        Exchange authorization code for tokens
        Args:
            code: Authorization code from OAuth callback
            redirect_uri: Redirect URI used in authorization
        Returns:
            Dict with access_token, refresh_token, expires_in, scope, token_type
        """
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    'https://oauth2.googleapis.com/token',
                    headers={'Content-Type': 'application/x-www-form-urlencoded'},
                    data={
                        'code': code,
                        'client_id': self.client_id,
                        'client_secret': self.client_secret,
                        'redirect_uri': redirect_uri,
                        'grant_type': 'authorization_code'
                    },
                    timeout=30.0
                )
            
            if not response.is_success:
                error_data = response.json() if response.headers.get('content-type', '').startswith('application/json') else {}
                error_msg = error_data.get('error_description') or error_data.get('error') or f'HTTP {response.status_code}'
                logger.error(f'Google OAuth token exchange failed: {error_msg}', error_data)
                raise Exception(f'Failed to exchange authorization code: {error_msg}')
            
            tokens = response.json()
            
            # Validate required fields
            if not tokens.get('access_token'):
                raise Exception('No access_token received from Google')
            
            logger.info(
                f'Google OAuth token exchange successful',
                hasAccessToken=bool(tokens.get('access_token')),
                hasRefreshToken=bool(tokens.get('refresh_token')),
                expiresIn=tokens.get('expires_in'),
                scope=tokens.get('scope', '')[:100]
            )
            
            return {
                'access_token': tokens['access_token'],
                'refresh_token': tokens.get('refresh_token'),  # May be None if user already consented
                'expires_in': tokens.get('expires_in', 3600),
                'scope': tokens.get('scope', ''),
                'token_type': tokens.get('token_type', 'Bearer')
            }
        except httpx.TimeoutException:
            logger.error('Google OAuth token exchange timed out')
            raise Exception('OAuth token exchange timed out')
        except Exception as e:
            logger.error(f'Google OAuth token exchange error: {str(e)}')
            raise
    
    async def refresh_token(
        self,
        refresh_token: str
    ) -> Dict[str, Any]:
        """
        Refresh access token using refresh token
        Args:
            refresh_token: Refresh token
        Returns:
            Dict with access_token, expires_in
        """
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    'https://oauth2.googleapis.com/token',
                    headers={'Content-Type': 'application/x-www-form-urlencoded'},
                    data={
                        'client_id': self.client_id,
                        'client_secret': self.client_secret,
                        'refresh_token': refresh_token,
                        'grant_type': 'refresh_token'
                    },
                    timeout=30.0
                )
            
            if not response.is_success:
                error_data = response.json() if response.headers.get('content-type', '').startswith('application/json') else {}
                error_code = error_data.get('error')
                
                if error_code == 'invalid_grant':
                    logger.error('Google refresh token invalid_grant - token likely revoked')
                    raise Exception('REVOKED_REFRESH_TOKEN')
                
                error_msg = error_data.get('error_description') or error_data.get('error') or f'HTTP {response.status_code}'
                logger.error(f'Google token refresh failed: {error_msg}')
                raise Exception(f'Token refresh failed: {error_msg}')
            
            data = response.json()
            
            return {
                'access_token': data.get('access_token'),
                'expires_in': data.get('expires_in', 3600)
            }
        except httpx.TimeoutException:
            logger.error('Google token refresh timed out')
            raise Exception('Token refresh timed out')
        except Exception as e:
            logger.error(f'Google token refresh error: {str(e)}')
            raise
    
    async def revoke_token(
        self,
        token: str
    ) -> bool:
        """
        Revoke access or refresh token
        Args:
            token: Access token or refresh token to revoke
        Returns:
            Success status
        """
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    'https://oauth2.googleapis.com/revoke',
                    headers={'Content-Type': 'application/x-www-form-urlencoded'},
                    data={'token': token},
                    timeout=30.0
                )
            
            # Google returns 200 even if token was already revoked
            return response.is_success
        except Exception as e:
            logger.error(f'Google token revocation error: {str(e)}')
            return False
    
    def get_provider_name(self) -> str:
        """Get provider name"""
        return 'google'

