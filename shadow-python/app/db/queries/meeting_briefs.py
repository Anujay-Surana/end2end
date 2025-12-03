"""
Meeting Briefs Database Queries

CRUD operations for meeting_briefs table
"""

from app.db.connection import supabase
from typing import Dict, List, Any, Optional
from datetime import date
from app.services.logger import logger


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
    date_str = meeting_date.isoformat()
    logger.info(f'Fetching briefs for user_id={user_id}, meeting_date={date_str}')
    
    # Try direct date filter first
    try:
        response = supabase.table('meeting_briefs').select('*').eq('user_id', user_id).eq('meeting_date', date_str).execute()
        
        if hasattr(response, 'error') and response.error:
            logger.warning(f'Database error with date filter: {response.error.message}')
        elif response.data and len(response.data) > 0:
            logger.info(f'Found {len(response.data)} briefs with direct date filter')
            return response.data
        else:
            logger.info(f'Direct date filter returned 0 results for date={date_str}')
    except Exception as e:
        logger.warning(f'Date filter query failed: {str(e)}')
    
    # Fallback: fetch all user briefs and filter by date in Python
    # This handles potential data type mismatches in Supabase
    logger.info(f'Trying fallback: fetching all briefs for user and filtering by meeting_date')
    try:
        all_briefs_response = supabase.table('meeting_briefs').select('*').eq('user_id', user_id).execute()
        
        if hasattr(all_briefs_response, 'error') and all_briefs_response.error:
            raise Exception(f'Database error: {all_briefs_response.error.message}')
        
        all_briefs = all_briefs_response.data or []
        logger.info(f'Fetched {len(all_briefs)} total briefs for user')
        
        # Debug: log all meeting_dates in the database
        for brief in all_briefs[:5]:  # Log first 5 for debugging
            db_date = brief.get('meeting_date')
            logger.info(f'  Brief meeting_id={brief.get("meeting_id")}, meeting_date={db_date} (type={type(db_date).__name__})')
        
        # Filter by matching date - handle both string and date object comparisons
        filtered_briefs = []
        for brief in all_briefs:
            db_date = brief.get('meeting_date')
            if db_date is None:
                continue
            
            # Handle different possible formats
            if isinstance(db_date, str):
                # Exact string match or date part match (in case of timestamp)
                if db_date == date_str or db_date.startswith(date_str):
                    filtered_briefs.append(brief)
            elif hasattr(db_date, 'isoformat'):
                # It's a date/datetime object
                if db_date.isoformat().startswith(date_str):
                    filtered_briefs.append(brief)
        
        logger.info(f'Fallback found {len(filtered_briefs)} briefs matching date {date_str}')
        return filtered_briefs
        
    except Exception as e:
        logger.error(f'Fallback query also failed: {str(e)}')
        return []


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

