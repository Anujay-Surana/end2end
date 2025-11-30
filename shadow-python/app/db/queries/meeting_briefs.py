"""
Meeting Briefs Database Queries

CRUD operations for meeting_briefs table
"""

from app.db.connection import supabase
from typing import Dict, List, Any, Optional


async def create_meeting_brief(user_id: str, meeting_id: str, brief_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Create or update a meeting brief
    Args:
        user_id: User UUID
        meeting_id: Google Calendar event ID
        brief_data: Full brief object as dict
    Returns:
        Created/updated brief
    """
    response = supabase.table('meeting_briefs').upsert(
        {
            'user_id': user_id,
            'meeting_id': meeting_id,
            'brief_data': brief_data
        },
        on_conflict='user_id,meeting_id'
    ).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to create meeting brief: {response.error.message}')
    
    # Query to get the created/updated record
    result = supabase.table('meeting_briefs').select('*').eq('user_id', user_id).eq('meeting_id', meeting_id).maybe_single().execute()
    
    if result.data:
        return result.data
    raise Exception('Failed to create meeting brief')


async def get_meeting_brief(user_id: str, meeting_id: str) -> Optional[Dict[str, Any]]:
    """
    Get a meeting brief
    Args:
        user_id: User UUID
        meeting_id: Google Calendar event ID
    Returns:
        Brief or None
    """
    response = supabase.table('meeting_briefs').select('*').eq('user_id', user_id).eq('meeting_id', meeting_id).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return None


async def get_user_briefs(user_id: str, limit: int = 100) -> List[Dict[str, Any]]:
    """
    Get all briefs for a user
    Args:
        user_id: User UUID
        limit: Maximum number of briefs to return
    Returns:
        List of briefs
    """
    response = supabase.table('meeting_briefs').select('*').eq('user_id', user_id).order('created_at', desc=True).limit(limit).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return []


async def delete_meeting_brief(user_id: str, meeting_id: str) -> bool:
    """
    Delete a meeting brief
    Args:
        user_id: User UUID
        meeting_id: Google Calendar event ID
    Returns:
        Success
    """
    response = supabase.table('meeting_briefs').delete().eq('user_id', user_id).eq('meeting_id', meeting_id).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to delete meeting brief: {response.error.message}')
    return True

