"""
Meeting Briefs Database Queries

CRUD operations for meeting_briefs table
"""

from app.db.connection import supabase
from typing import Dict, List, Any, Optional
from datetime import date


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
    
    if result and hasattr(result, 'data') and result.data:
        return result.data
    raise Exception('Failed to create meeting brief')


async def upsert_meeting_brief(
    user_id: str,
    meeting_id: str,
    brief_data: Dict[str, Any],
    one_liner_summary: str = '',
    meeting_date: Optional[date] = None
) -> Dict[str, Any]:
    """
    Create or update a meeting brief with one-liner summary
    Args:
        user_id: User UUID
        meeting_id: Google Calendar event ID
        brief_data: Full brief object as dict
        one_liner_summary: Short summary of the meeting
        meeting_date: Date of the meeting
    Returns:
        Created/updated brief
    """
    data = {
        'user_id': user_id,
        'meeting_id': meeting_id,
        'brief_data': brief_data,
        'one_liner_summary': one_liner_summary
    }
    
    if meeting_date:
        data['meeting_date'] = meeting_date.isoformat()
    
    response = supabase.table('meeting_briefs').upsert(
        data,
        on_conflict='user_id,meeting_id'
    ).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to upsert meeting brief: {response.error.message}')
    
    # Query to get the created/updated record
    result = supabase.table('meeting_briefs').select('*').eq('user_id', user_id).eq('meeting_id', meeting_id).maybe_single().execute()
    
    if result and hasattr(result, 'data') and result.data:
        return result.data
    raise Exception('Failed to upsert meeting brief')


async def get_briefs_for_user_date(user_id: str, meeting_date: date) -> List[Dict[str, Any]]:
    """
    Get all briefs for a user on a specific date
    Args:
        user_id: User UUID
        meeting_date: Date to fetch briefs for
    Returns:
        List of briefs
    """
    response = supabase.table('meeting_briefs').select('*').eq('user_id', user_id).eq('meeting_date', meeting_date.isoformat()).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    
    return response.data or []


async def get_brief_by_meeting_id(user_id: str, meeting_id: str) -> Optional[Dict[str, Any]]:
    """
    Get a brief by meeting ID
    Args:
        user_id: User UUID
        meeting_id: Google Calendar event ID
    Returns:
        Brief or None
    """
    response = supabase.table('meeting_briefs').select('*').eq('user_id', user_id).eq('meeting_id', meeting_id).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    
    return response.data


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

