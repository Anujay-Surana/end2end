"""
Utility functions shared across services
"""

from typing import Dict, Any, Optional


def get_meeting_datetime(meeting: Dict[str, Any], field: str = 'start') -> Optional[str]:
    """
    Safely extract datetime string from meeting start/end field.
    Handles both dict format {'dateTime': '...'} and string format '2025-12-03'.
    
    Args:
        meeting: Meeting dict
        field: Field name ('start' or 'end')
    Returns:
        Datetime string or None
    """
    value = meeting.get(field)
    if isinstance(value, dict):
        return value.get('dateTime') or value.get('date')
    elif isinstance(value, str):
        return value
    return None

