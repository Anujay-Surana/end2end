"""
Chat Messages Database Queries

CRUD operations for chat_messages table
"""

from app.db.connection import supabase
from typing import Dict, List, Any, Optional
import json
from app.services.logger import logger


async def create_chat_message(
    user_id: str,
    role: str,
    content: str,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Create a chat message
    Args:
        user_id: User UUID
        role: Message role ('user', 'assistant', 'system', 'tool')
        content: Message content
        metadata: Optional metadata dict
    Returns:
        Created message
    """
    message_data = {
        'user_id': user_id,
        'role': role,
        'content': content
    }
    
    if metadata:
        # Ensure metadata is properly formatted as a dict
        if isinstance(metadata, dict):
            message_data['metadata'] = metadata
        elif isinstance(metadata, str):
            try:
                message_data['metadata'] = json.loads(metadata)
            except json.JSONDecodeError:
                message_data['metadata'] = {}
        else:
            message_data['metadata'] = {}
    
    response = supabase.table('chat_messages').insert(message_data).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to create chat message: {response.error.message}')
    
    if response.data and len(response.data) > 0:
        return response.data[0]
    raise Exception('Failed to create chat message')


async def get_chat_messages(
    user_id: str,
    limit: int = 100
) -> List[Dict[str, Any]]:
    """
    Get chat messages for a user
    Args:
        user_id: User UUID
        limit: Maximum number of messages to return
    Returns:
        List of messages
    """
    # Use explicit column selection to ensure JSONB metadata is properly retrieved
    # PostgREST may not properly serialize JSONB with select('*')
    query = supabase.table('chat_messages').select('id, user_id, role, content, metadata, created_at').eq('user_id', user_id)
    
    response = query.order('created_at', desc=False).limit(limit).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        processed_messages = []
        for msg in response.data:
            raw_metadata = msg.get('metadata')
            
            # Handle metadata deserialization
            if raw_metadata is None:
                msg['metadata'] = {}
            elif isinstance(raw_metadata, str):
                # Metadata came back as JSON string - parse it
                try:
                    parsed = json.loads(raw_metadata)
                    msg['metadata'] = parsed if isinstance(parsed, dict) else {}
                except (json.JSONDecodeError, TypeError):
                    msg['metadata'] = {}
            elif isinstance(raw_metadata, dict):
                # Already a dict - use as-is
                msg['metadata'] = raw_metadata
            else:
                # Unexpected type - default to empty dict
                msg['metadata'] = {}
            
            processed_messages.append(msg)
        
        return processed_messages
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


async def delete_user_chat_messages(user_id: str) -> bool:
    """
    Delete all chat messages for a user
    Args:
        user_id: User UUID
    Returns:
        Success
    """
    response = supabase.table('chat_messages').delete().eq('user_id', user_id).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to delete chat messages: {response.error.message}')
    return True


async def get_meeting_chat_messages(
    user_id: str,
    meeting_id: str,
    limit: int = 100
) -> List[Dict[str, Any]]:
    """
    Get chat messages for a specific meeting
    Args:
        user_id: User UUID
        meeting_id: Google Calendar event ID
        limit: Maximum number of messages to return
    Returns:
        List of messages for the meeting
    """
    # Use Supabase JSONB containment filter for server-side filtering
    # This is much more efficient than client-side filtering
    query = supabase.table('chat_messages') \
        .select('id, user_id, role, content, metadata, created_at') \
        .eq('user_id', user_id) \
        .contains('metadata', {'meeting_id': meeting_id})
    
    response = query.order('created_at', desc=False).limit(limit).execute()
    
    if hasattr(response, 'error') and response.error:
        # Fall back to client-side filtering if server-side fails
        logger.warning(f'Server-side JSONB filter failed, falling back to client-side: {response.error.message}')
        return await _get_meeting_chat_messages_fallback(user_id, meeting_id, limit)
    
    if not response.data:
        return []
    
    # Process metadata for consistency
    processed_messages = []
    for msg in response.data:
        raw_metadata = msg.get('metadata')
        
        # Handle metadata deserialization
        if raw_metadata is None:
            msg['metadata'] = {}
        elif isinstance(raw_metadata, str):
            try:
                msg['metadata'] = json.loads(raw_metadata)
            except (json.JSONDecodeError, TypeError):
                msg['metadata'] = {}
        elif isinstance(raw_metadata, dict):
            msg['metadata'] = raw_metadata
        else:
            msg['metadata'] = {}
        
        processed_messages.append(msg)
    
    return processed_messages


async def _get_meeting_chat_messages_fallback(
    user_id: str,
    meeting_id: str,
    limit: int = 100
) -> List[Dict[str, Any]]:
    """
    Fallback client-side filtering for meeting chat messages
    Used when Supabase JSONB filter is not available
    """
    # Fetch ALL messages for the user (up to a high limit) to ensure we find meeting messages
    query = supabase.table('chat_messages') \
        .select('id, user_id, role, content, metadata, created_at') \
        .eq('user_id', user_id)
    
    response = query.order('created_at', desc=False).limit(1000).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    
    if not response.data:
        return []
    
    # Filter messages by meeting_id in metadata
    meeting_messages = []
    for msg in response.data:
        raw_metadata = msg.get('metadata')
        
        # Handle metadata deserialization
        if raw_metadata is None:
            metadata = {}
        elif isinstance(raw_metadata, str):
            try:
                metadata = json.loads(raw_metadata)
            except (json.JSONDecodeError, TypeError):
                metadata = {}
        elif isinstance(raw_metadata, dict):
            metadata = raw_metadata
        else:
            metadata = {}
        
        msg['metadata'] = metadata
        
        # Check if this message is for the specified meeting
        if metadata.get('meeting_id') == meeting_id:
            meeting_messages.append(msg)
    
    return meeting_messages[:limit]


async def create_meeting_chat_message(
    user_id: str,
    meeting_id: str,
    role: str,
    content: str,
    metadata: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Create a chat message for a specific meeting
    Args:
        user_id: User UUID
        meeting_id: Google Calendar event ID
        role: Message role ('user', 'assistant')
        content: Message content
        metadata: Optional additional metadata
    Returns:
        Created message
    """
    # Ensure meeting_id is in metadata
    msg_metadata = metadata.copy() if metadata else {}
    msg_metadata['meeting_id'] = meeting_id
    
    return await create_chat_message(
        user_id=user_id,
        role=role,
        content=content,
        metadata=msg_metadata
    )

