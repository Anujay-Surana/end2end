"""
OAuth Manager

High-level OAuth operations and provider management
"""

import secrets
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta
from app.services.oauth.google_oauth import GoogleOAuthProvider
from app.services.oauth.oauth_provider import OAuthProvider
from app.services.logger import logger


class OAuthManager:
    """Manages OAuth flows for multiple providers"""
    
    def __init__(self):
        self.providers: Dict[str, OAuthProvider] = {
            'google': GoogleOAuthProvider()
        }
        # In-memory state storage (in production, use Redis or database)
        self.oauth_states: Dict[str, Dict[str, Any]] = {}
    
    def get_provider(self, provider_name: str) -> OAuthProvider:
        """
        Get OAuth provider by name
        Args:
            provider_name: Provider name ('google', 'microsoft', etc.)
        Returns:
            OAuth provider instance
        """
        provider = self.providers.get(provider_name.lower())
        if not provider:
            raise ValueError(f'Unsupported OAuth provider: {provider_name}')
        return provider
    
    def initiate_oauth(
        self,
        provider_name: str,
        redirect_uri: str,
        scopes: List[str],
        user_id: Optional[str] = None,
        prompt: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Initiate OAuth flow - generate authorization URL and state
        Args:
            provider_name: Provider name ('google', etc.)
            redirect_uri: OAuth redirect URI
            scopes: List of requested scopes
            user_id: User ID (if adding account to existing user)
            prompt: Prompt type (consent, select_account, none)
        Returns:
            Dict with authorization_url and state
        """
        provider = self.get_provider(provider_name)
        
        # Generate state for CSRF protection
        state = secrets.token_urlsafe(32)
        
        # Store state with metadata
        self.oauth_states[state] = {
            'provider': provider_name,
            'redirect_uri': redirect_uri,
            'scopes': scopes,
            'user_id': user_id,
            'created_at': datetime.utcnow(),
            'expires_at': datetime.utcnow() + timedelta(minutes=10)  # 10 minute expiry
        }
        
        # Generate authorization URL
        authorization_url = provider.get_authorization_url(
            redirect_uri=redirect_uri,
            scopes=scopes,
            state=state,
            prompt=prompt
        )
        
        logger.info(
            f'OAuth flow initiated',
            provider=provider_name,
            scopes=scopes,
            hasState=bool(state)
        )
        
        return {
            'authorization_url': authorization_url,
            'state': state,
            'provider': provider_name
        }
    
    def validate_state(
        self,
        state: str
    ) -> Optional[Dict[str, Any]]:
        """
        Validate OAuth state and return stored metadata
        Args:
            state: OAuth state parameter
        Returns:
            State metadata or None if invalid/expired
        """
        state_data = self.oauth_states.get(state)
        
        if not state_data:
            logger.warning(f'Invalid OAuth state: {state}')
            return None
        
        # Check expiration
        if datetime.utcnow() > state_data['expires_at']:
            logger.warning(f'Expired OAuth state: {state}')
            del self.oauth_states[state]
            return None
        
        return state_data
    
    def consume_state(
        self,
        state: str
    ) -> Optional[Dict[str, Any]]:
        """
        Validate and consume OAuth state (one-time use)
        Args:
            state: OAuth state parameter
        Returns:
            State metadata or None if invalid/expired
        """
        state_data = self.validate_state(state)
        
        if state_data:
            # Remove state after use (one-time use)
            del self.oauth_states[state]
        
        return state_data
    
    async def exchange_code(
        self,
        provider_name: str,
        code: str,
        redirect_uri: str,
        state: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Exchange authorization code for tokens
        Args:
            provider_name: Provider name
            code: Authorization code
            redirect_uri: Redirect URI used in authorization
            state: OAuth state (optional, for validation)
        Returns:
            Token response with access_token, refresh_token, etc.
        """
        # Validate state if provided
        if state:
            state_data = self.consume_state(state)
            if not state_data:
                raise Exception('Invalid or expired OAuth state')
            
            # Verify redirect_uri matches
            if state_data['redirect_uri'] != redirect_uri:
                raise Exception('Redirect URI mismatch')
        
        provider = self.get_provider(provider_name)
        tokens = await provider.exchange_code(code, redirect_uri)
        
        logger.info(
            f'OAuth code exchanged successfully',
            provider=provider_name,
            hasAccessToken=bool(tokens.get('access_token')),
            hasRefreshToken=bool(tokens.get('refresh_token'))
        )
        
        return tokens
    
    async def refresh_access_token(
        self,
        provider_name: str,
        refresh_token: str
    ) -> Dict[str, Any]:
        """
        Refresh access token
        Args:
            provider_name: Provider name
            refresh_token: Refresh token
        Returns:
            New access token data
        """
        provider = self.get_provider(provider_name)
        return await provider.refresh_token(refresh_token)
    
    async def revoke_token(
        self,
        provider_name: str,
        token: str
    ) -> bool:
        """
        Revoke access or refresh token
        Args:
            provider_name: Provider name
            token: Token to revoke
        Returns:
            Success status
        """
        provider = self.get_provider(provider_name)
        return await provider.revoke_token(token)
    
    def get_supported_providers(self) -> List[str]:
        """Get list of supported OAuth providers"""
        return list(self.providers.keys())
    
    def register_provider(
        self,
        provider_name: str,
        provider: OAuthProvider
    ):
        """
        Register a new OAuth provider
        Args:
            provider_name: Provider name
            provider: OAuth provider instance
        """
        self.providers[provider_name.lower()] = provider
        logger.info(f'OAuth provider registered: {provider_name}')

