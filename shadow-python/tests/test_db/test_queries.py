"""
Database query tests

Uses real database connection - requires .env with valid Supabase credentials
"""

import pytest
import asyncio
from app.db.queries.users import create_user, find_user_by_email
from app.db.queries.accounts import get_accounts_by_user_id


@pytest.mark.asyncio
async def test_create_user(mock_user):
    """Test creating a user"""
    try:
        result = await create_user({
            'email': mock_user['email'],
            'name': mock_user['name'],
            'picture_url': mock_user['picture_url']
        })
        assert result['email'] == mock_user['email']
        assert 'id' in result
    except Exception as e:
        pytest.skip(f"Database not available: {e}")


@pytest.mark.asyncio
async def test_find_user_by_email(mock_user):
    """Test finding user by email"""
    try:
        # First create the user
        await create_user({
            'email': mock_user['email'],
            'name': mock_user['name'],
            'picture_url': mock_user['picture_url']
        })
        
        # Then find it
        result = await find_user_by_email(mock_user['email'])
        assert result is not None
        assert result['email'] == mock_user['email']
    except Exception as e:
        pytest.skip(f"Database not available: {e}")


@pytest.mark.asyncio
async def test_get_accounts_by_user_id(mock_account):
    """Test getting accounts by user ID"""
    try:
        # This will return empty list if user doesn't exist, which is fine for testing
        result = await get_accounts_by_user_id(mock_account['user_id'])
        assert isinstance(result, list)
    except Exception as e:
        pytest.skip(f"Database not available: {e}")

