"""
Account management route tests
"""

import pytest
from fastapi import status


def test_list_accounts_unauthorized(client):
    """Test listing accounts without authentication"""
    response = client.get('/api/accounts')
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_delete_account_unauthorized(client):
    """Test deleting account without authentication"""
    response = client.delete('/api/accounts/test-account-id')
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_set_primary_account_unauthorized(client):
    """Test setting primary account without authentication"""
    response = client.put('/api/accounts/test-account-id/set-primary')
    assert response.status_code == status.HTTP_401_UNAUTHORIZED

