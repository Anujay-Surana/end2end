"""
Sessions Database Queries

CRUD operations for sessions table using Supabase
"""

import secrets
from datetime import datetime, timedelta
from app.db.connection import supabase


def generate_session_token() -> str:
    """
    Generate a secure random session token
    Returns:
        Random session token
    """
    return secrets.token_hex(32)


async def create_session(user_id: str, expires_in_days: int = 30) -> dict:
    """
    Create a new session
    Args:
        user_id: User UUID
        expires_in_days: Session duration in days (default: 30)
    Returns:
        Created session
    """
    session_token = generate_session_token()
    expires_at = datetime.utcnow() + timedelta(days=expires_in_days)
    
    # Supabase insert().select() pattern doesn't work - need to query after insert
    # First insert the record
    insert_response = supabase.table('sessions').insert({
        'user_id': user_id,
        'session_token': session_token,
        'expires_at': expires_at.isoformat()
    }).execute()
    
    if hasattr(insert_response, 'error') and insert_response.error:
        raise Exception(f'Failed to create session: {insert_response.error.message}')
    
    # Then query to get the created record
    response = supabase.table('sessions').select('*').eq('session_token', session_token).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to fetch session: {response.error.message}')
    if response.data:
        return response.data
    raise Exception('Failed to create session')


async def find_session_by_token(session_token: str) -> dict | None:
    """
    Find session by token
    Args:
        session_token: Session token
    Returns:
        Session or None
    """
    now = datetime.utcnow().isoformat()
    response = supabase.table('sessions').select('*').eq('session_token', session_token).gt(
        'expires_at', now
    ).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return None


async def delete_session(session_token: str) -> bool:
    """
    Delete a session (logout)
    Args:
        session_token: Session token
    Returns:
        Success
    """
    response = supabase.table('sessions').delete().eq('session_token', session_token).select('id').execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to delete session: {response.error.message}')
    return response.data is not None and len(response.data) > 0


async def delete_all_user_sessions(user_id: str) -> int:
    """
    Delete all sessions for a user (logout all devices)
    Args:
        user_id: User UUID
    Returns:
        Number of sessions deleted
    """
    response = supabase.table('sessions').delete().eq('user_id', user_id).select('id').execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to delete user sessions: {response.error.message}')
    return len(response.data) if response.data else 0


async def delete_expired_sessions() -> int:
    """
    Delete expired sessions (cleanup)
    Returns:
        Number of sessions deleted
    """
    now = datetime.utcnow().isoformat()
    # Note: Supabase delete().lt() doesn't support .select() directly
    # Workaround: Query expired sessions first, then delete by IDs
    query_response = supabase.table('sessions').select('id').lt('expires_at', now).execute()
    
    if hasattr(query_response, 'error') and query_response.error:
        raise Exception(f'Failed to query expired sessions: {query_response.error.message}')
    
    if not query_response.data or len(query_response.data) == 0:
        return 0
    
    # Delete expired sessions by ID (batch delete)
    expired_ids = [row['id'] for row in query_response.data]
    deleted_count = 0
    
    # Delete in batches of 100 to avoid overwhelming the database
    batch_size = 100
    for i in range(0, len(expired_ids), batch_size):
        batch = expired_ids[i:i + batch_size]
        for session_id in batch:
            try:
                delete_response = supabase.table('sessions').delete().eq('id', session_id).select('id').execute()
                if delete_response.data:
                    deleted_count += 1
            except Exception as e:
                # Log but continue with other deletions
                pass
    
    return deleted_count


async def get_user_sessions(user_id: str) -> list:
    """
    Get all active sessions for a user
    Args:
        user_id: User UUID
    Returns:
        Array of sessions
    """
    now = datetime.utcnow().isoformat()
    response = supabase.table('sessions').select(
        'id, user_id, session_token, expires_at, created_at'
    ).eq('user_id', user_id).gt('expires_at', now).order('created_at', desc=True).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    return response.data if response.data else []


async def extend_session(session_token: str, expires_in_days: int = 30) -> dict | None:
    """
    Extend session expiration
    Args:
        session_token: Session token
        expires_in_days: Additional days to extend
    Returns:
        Updated session or None
    """
    new_expires_at = datetime.utcnow() + timedelta(days=expires_in_days)
    now = datetime.utcnow().isoformat()
    
    # Supabase update().eq().gt().select() pattern doesn't work - need to query after update
    # First update the record
    update_response = supabase.table('sessions').update({
        'expires_at': new_expires_at.isoformat()
    }).eq('session_token', session_token).gt('expires_at', now).execute()
    
    if hasattr(update_response, 'error') and update_response.error:
        raise Exception(f'Database error: {update_response.error.message}')
    
    # Then query to get the updated record
    response = supabase.table('sessions').select('*').eq('session_token', session_token).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return None

