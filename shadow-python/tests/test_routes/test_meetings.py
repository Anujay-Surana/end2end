"""
Meeting preparation route tests
"""

import pytest
from fastapi import status


def test_prep_meeting_missing_meeting(client):
    """Test meeting prep with missing meeting data"""
    response = client.post('/api/prep-meeting', json={'attendees': []})
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


def test_get_meetings_for_day_missing_date(client):
    """Test getting meetings without date parameter"""
    response = client.get('/api/meetings-for-day')
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY


def test_get_meetings_for_day_invalid_date(client):
    """Test getting meetings with invalid date format"""
    response = client.get('/api/meetings-for-day?date=invalid-date')
    assert response.status_code == status.HTTP_400_BAD_REQUEST

