"""
Day prep route tests
"""

import pytest
from fastapi import status


def test_day_prep_missing_date(client):
    """Test day prep without date"""
    response = client.post('/api/day-prep', json={})
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


def test_day_prep_invalid_date(client):
    """Test day prep with invalid date format"""
    response = client.post('/api/day-prep', json={'date': 'invalid-date'})
    # Should return 400 or 500 depending on validation
    assert response.status_code in [status.HTTP_400_BAD_REQUEST, status.HTTP_500_INTERNAL_SERVER_ERROR]

