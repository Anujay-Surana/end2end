"""
Chat Messages Database Queries

CRUD operations for chat_messages table
"""

from app.db.connection import supabase
from typing import Dict, List, Any, Optional


async def create_chat_message(
    user_id: str,
    role: str,
    content: str,
    meeting_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Create a chat message
    Args:
        user_id: User UUID
        role: Message role ('user', 'assistant', 'system')
        content: Message content
        meeting_id: Optional meeting ID
        metadata: Optional metadata dict
    Returns:
        Created message
    """
    message_data = {
        'user_id': user_id,
        'role': role,
        'content': content
    }
    
    if meeting_id:
        message_data['meeting_id'] = meeting_id
    if metadata:
        message_data['metadata'] = metadata
    
    response = supabase.table('chat_messages').insert(message_data).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to create chat message: {response.error.message}')
    
    if response.data and len(response.data) > 0:
        return response.data[0]
    raise Exception('Failed to create chat message')


async def get_chat_messages(
    user_id: str,
    meeting_id: Optional[str] = None,
    limit: int = 100
) -> List[Dict[str, Any]]:
    """
    Get chat messages for a user
    Args:
        user_id: User UUID
        meeting_id: Optional meeting ID filter
        limit: Maximum number of messages to return
    Returns:
        List of messages
    """
    query = supabase.table('chat_messages').select('*').eq('user_id', user_id)
    
    if meeting_id:
        query = query.eq('meeting_id', meeting_id)
    
    response = query.order('created_at', desc=False).limit(limit).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return []


async def delete_chat_message(message_id: str) -> bool:
    """
    Delete a chat message
    Args:
        message_id: Message UUID
    Returns:
        Success
    """
    response = supabase.table('chat_messages').delete().eq('id', message_id).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to delete chat message: {response.error.message}')
    return True


async def delete_user_chat_messages(user_id: str, meeting_id: Optional[str] = None) -> bool:
    """
    Delete all chat messages for a user (optionally filtered by meeting)
    Args:
        user_id: User UUID
        meeting_id: Optional meeting ID filter
    Returns:
        Success
    """
    query = supabase.table('chat_messages').delete().eq('user_id', user_id)
    
    if meeting_id:
        query = query.eq('meeting_id', meeting_id)
    
    response = query.execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to delete chat messages: {response.error.message}')
    return True

