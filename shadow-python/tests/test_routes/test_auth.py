"""
Authentication route tests
"""

import pytest
from unittest.mock import patch, AsyncMock
from fastapi import status


def test_health_check(client):
    """Test health check endpoint"""
    response = client.get('/health')
    assert response.status_code == status.HTTP_200_OK
    assert response.json() == {'status': 'ok', 'service': 'humanmax-backend'}


def test_google_callback_missing_code(client):
    """Test OAuth callback without code"""
    response = client.post('/auth/google/callback', json={})
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


def test_get_current_user_unauthorized(client):
    """Test getting current user without authentication"""
    response = client.get('/auth/me')
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_logout_unauthorized(client):
    """Test logout without authentication"""
    response = client.post('/auth/logout')
    assert response.status_code == status.HTTP_401_UNAUTHORIZED

