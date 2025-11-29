"""
OAuth Provider Interface

Abstract base class for OAuth providers (Google, Microsoft, etc.)
"""

from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional
from urllib.parse import urlencode


class OAuthProvider(ABC):
    """Abstract base class for OAuth providers"""
    
    @abstractmethod
    def get_authorization_url(
        self,
        redirect_uri: str,
        scopes: List[str],
        state: Optional[str] = None,
        prompt: Optional[str] = None
    ) -> str:
        """
        Generate OAuth authorization URL
        Args:
            redirect_uri: OAuth redirect URI
            scopes: List of requested scopes
            state: OAuth state parameter (for CSRF protection)
            prompt: Prompt type (consent, select_account, etc.)
        Returns:
            Authorization URL
        """
        pass
    
    @abstractmethod
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
            Dict with access_token, refresh_token, expires_in, scope, etc.
        """
        pass
    
    @abstractmethod
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
        pass
    
    @abstractmethod
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
        pass
    
    @abstractmethod
    def get_provider_name(self) -> str:
        """Get provider name (e.g., 'google', 'microsoft')"""
        pass

