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
    
    response = supabase.table('sessions').insert({
        'user_id': user_id,
        'session_token': session_token,
        'expires_at': expires_at.isoformat()
    }).select().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to create session: {response.error.message}')
    if response.data and len(response.data) > 0:
        return response.data[0]
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
    response = supabase.table('sessions').delete().lt('expires_at', now).select('id').execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to delete expired sessions: {response.error.message}')
    return len(response.data) if response.data else 0


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
    
    response = supabase.table('sessions').update({
        'expires_at': new_expires_at.isoformat()
    }).eq('session_token', session_token).gt('expires_at', now).select().maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return None

