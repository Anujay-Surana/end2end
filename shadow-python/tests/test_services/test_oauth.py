"""
OAuth service tests
"""

import pytest
from unittest.mock import patch, AsyncMock
from app.services.oauth.oauth_manager import OAuthManager
from app.services.oauth.google_oauth import GoogleOAuthProvider


def test_oauth_manager_get_provider():
    """Test getting OAuth provider"""
    manager = OAuthManager()
    provider = manager.get_provider('google')
    assert isinstance(provider, GoogleOAuthProvider)


def test_oauth_manager_unsupported_provider():
    """Test getting unsupported provider"""
    manager = OAuthManager()
    with pytest.raises(ValueError):
        manager.get_provider('microsoft')


@pytest.mark.asyncio
async def test_oauth_manager_initiate_oauth():
    """Test initiating OAuth flow"""
    manager = OAuthManager()
    result = manager.initiate_oauth(
        provider_name='google',
        redirect_uri='postmessage',
        scopes=['openid', 'email']
    )
    assert 'authorization_url' in result
    assert 'state' in result
    assert result['provider'] == 'google'


def test_google_oauth_provider_init():
    """Test Google OAuth provider initialization"""
    # Uses real environment variables from .env
    try:
        provider = GoogleOAuthProvider()
        assert provider.client_id is not None
        assert provider.client_secret is not None
        assert len(provider.client_id) > 0
        assert len(provider.client_secret) > 0
    except ValueError as e:
        pytest.skip(f"Google OAuth not configured: {e}")

