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

