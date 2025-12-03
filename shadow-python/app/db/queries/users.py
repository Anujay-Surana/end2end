"""
User Database Queries

CRUD operations for users table using Supabase
"""

from app.db.connection import supabase
from typing import List, Dict, Any, Optional
from collections import Counter
from app.services.logger import logger


async def create_user(user_data: dict) -> dict:
    """
    Create a new user
    Args:
        user_data: User data dict with email, name, picture_url
    Returns:
        Created user
    """
    email = user_data.get('email')
    name = user_data.get('name')
    picture_url = user_data.get('picture_url')
    
    # Supabase upsert().select() pattern doesn't work - need to query after upsert
    # First upsert the record
    upsert_response = supabase.table('users').upsert(
        {'email': email, 'name': name, 'picture_url': picture_url},
        on_conflict='email'
    ).execute()
    
    if hasattr(upsert_response, 'error') and upsert_response.error:
        raise Exception(f'Failed to create or update user: {upsert_response.error.message}')
    
    # Then query to get the created/updated record
    response = supabase.table('users').select('*').eq('email', email).maybe_single().execute()
    
    if response is None:
        raise Exception('Failed to create user: No response from database')
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to fetch user: {response.error.message}')
    if response.data:
        return response.data
    raise Exception('Failed to create user')


async def find_user_by_email(email: str) -> dict | None:
    """
    Find user by email
    Args:
        email: User email
    Returns:
        User or None
    """
    if not email:
        return None
        
    response = supabase.table('users').select('*').eq('email', email).maybe_single().execute()
    
    if response is None:
        return None
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return None


async def find_user_by_id(user_id: str) -> dict | None:
    """
    Find user by ID
    Args:
        user_id: User UUID
    Returns:
        User or None
    """
    if not user_id:
        return None
        
    response = supabase.table('users').select('*').eq('id', user_id).maybe_single().execute()
    
    if response is None:
        return None
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return None


async def update_user(user_id: str, updates: dict) -> dict:
    """
    Update user
    Args:
        user_id: User UUID
        updates: Fields to update (name, picture_url, timezone)
    Returns:
        Updated user
    """
    name = updates.get('name')
    picture_url = updates.get('picture_url')
    timezone = updates.get('timezone')
    
    # Build update object conditionally (COALESCE logic in Python)
    update_data = {}
    if name is not None:
        update_data['name'] = name
    if picture_url is not None:
        update_data['picture_url'] = picture_url
    if timezone is not None:
        update_data['timezone'] = timezone
    
    # Supabase update().eq().select() pattern doesn't work - need to query after update
    # First update the record
    update_response = supabase.table('users').update(update_data).eq('id', user_id).execute()
    
    if hasattr(update_response, 'error') and update_response.error:
        raise Exception(f'Failed to update user: {update_response.error.message}')
    
    # Then query to get the updated record
    response = supabase.table('users').select('*').eq('id', user_id).maybe_single().execute()
    
    if response is None:
        raise Exception('Failed to update user: No response from database')
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to fetch updated user: {response.error.message}')
    if response.data:
        return response.data
    raise Exception('Failed to update user')


async def delete_user(user_id: str) -> bool:
    """
    Delete user (and all associated accounts via CASCADE)
    Args:
        user_id: User UUID
    Returns:
        Success
    """
    if not user_id:
        return False
    
    # Supabase delete().eq() doesn't support .select() - query first to verify existence
    try:
        # First check if user exists
        query_response = supabase.table('users').select('id').eq('id', user_id).maybe_single().execute()
        
        if query_response is None or not query_response.data:
            return False
        
        # Then delete (without select)
        delete_response = supabase.table('users').delete().eq('id', user_id).execute()
        
        if delete_response is None:
            return False
        if hasattr(delete_response, 'error') and delete_response.error:
            raise Exception(f'Failed to delete user: {delete_response.error.message}')
        
        return True
    except Exception as e:
        logger.warn(f'Error deleting user: {str(e)}')
        return False


async def extract_and_update_timezone_from_calendar(user_id: str, calendar_events: List[Dict[str, Any]]) -> Optional[str]:
    """
    Extract the most common timezone from calendar events and update user's timezone if different
    Args:
        user_id: User UUID
        calendar_events: List of calendar events (must have 'timeZone' field)
    Returns:
        Detected timezone string or None if no timezone found
    """
    if not calendar_events:
        return None
    
    # Extract timezones from calendar events
    timezones = []
    for event in calendar_events:
        timezone = event.get('timeZone')
        if timezone:
            timezones.append(timezone)
    
    if not timezones:
        return None
    
    # Find the most common timezone
    timezone_counter = Counter(timezones)
    most_common_timezone = timezone_counter.most_common(1)[0][0]
    
    # Get current user timezone
    user = await find_user_by_id(user_id)
    if not user:
        logger.warning(f'User not found: {user_id}')
        return None
    
    current_timezone = user.get('timezone', 'UTC')
    
    # Only update if timezone is different
    if most_common_timezone != current_timezone:
        try:
            await update_user(user_id, {'timezone': most_common_timezone})
            logger.info(
                f'Updated user timezone from {current_timezone} to {most_common_timezone}',
                userId=user_id,
                oldTimezone=current_timezone,
                newTimezone=most_common_timezone
            )
        except Exception as e:
            logger.error(f'Failed to update user timezone: {str(e)}', userId=user_id)
            return None
    
    return most_common_timezone

