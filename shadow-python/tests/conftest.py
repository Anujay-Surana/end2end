"""
Pytest configuration and fixtures

Uses real dependencies - database, APIs, etc.
Environment variables should be set in .env file
"""

import pytest
import os
from fastapi.testclient import TestClient

# Import app - uses real dependencies from .env
from app.main import app as app_instance


@pytest.fixture
def client():
    """FastAPI test client using real app"""
    return TestClient(app)


@pytest.fixture
def app():
    """Create FastAPI app instance"""
    return app_instance

@pytest.fixture
def client(app):
    """FastAPI test client"""
    return TestClient(app)


@pytest.fixture
def mock_user():
    """Mock user data"""
    return {
        'id': 'test-user-id-123',
        'email': 'test@example.com',
        'name': 'Test User',
        'picture_url': 'https://example.com/picture.jpg'
    }


@pytest.fixture
def mock_account():
    """Mock account data"""
    return {
        'id': 'test-account-id-123',
        'user_id': 'test-user-id-123',
        'provider': 'google',
        'account_email': 'test@example.com',
        'account_name': 'Test User',
        'access_token': 'test-access-token',
        'refresh_token': 'test-refresh-token',
        'token_expires_at': '2024-12-31T23:59:59',
        'scopes': ['openid', 'email', 'profile'],
        'is_primary': True
    }


@pytest.fixture
def mock_session():
    """Mock session data"""
    return {
        'id': 'test-session-id-123',
        'user_id': 'test-user-id-123',
        'session_token': 'test-session-token-123',
        'expires_at': '2024-12-31T23:59:59'
    }


@pytest.fixture
def mock_openai_response():
    """Mock OpenAI API response"""
    return {
        'id': 'chatcmpl-test',
        'object': 'chat.completion',
        'created': 1234567890,
        'model': 'gpt-4.1-mini',
        'choices': [{
            'index': 0,
            'message': {
                'role': 'assistant',
                'content': 'Test response'
            },
            'finish_reason': 'stop'
        }],
        'usage': {
            'prompt_tokens': 10,
            'completion_tokens': 5,
            'total_tokens': 15
        }
    }


@pytest.fixture
def mock_google_profile():
    """Mock Google user profile"""
    return {
        'email': 'test@example.com',
        'name': 'Test User',
        'picture': 'https://example.com/picture.jpg'
    }


@pytest.fixture
def mock_oauth_tokens():
    """Mock OAuth tokens"""
    return {
        'access_token': 'test-access-token',
        'refresh_token': 'test-refresh-token',
        'expires_in': 3600,
        'scope': 'openid email profile',
        'token_type': 'Bearer'
    }

