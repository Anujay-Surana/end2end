"""
Chat Routes

Endpoints for chat messages with database storage
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from app.middleware.auth import require_auth
from app.services.chat_panel_service import ChatPanelService
from app.db.queries.chat_messages import create_chat_message, get_chat_messages, delete_chat_message
from app.services.logger import logger
import os

router = APIRouter()


class ChatMessageRequest(BaseModel):
    message: str
    meeting_id: Optional[str] = None
    conversation_history: Optional[List[Dict[str, str]]] = None
    meetings: Optional[List[Dict[str, Any]]] = None


@router.get('/chat/messages')
async def get_messages(
    meeting_id: Optional[str] = Query(None, description='Filter by meeting ID'),
    limit: int = Query(100, ge=1, le=500, description='Maximum number of messages'),
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Get chat messages for the current user
    """
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
        messages = await get_chat_messages(
            user_id=user_id,
            meeting_id=meeting_id,
            limit=limit
        )
        
        return {
            'success': True,
            'messages': messages
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Error fetching chat messages: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=f'Failed to fetch messages: {str(e)}')


@router.post('/chat/messages')
async def send_message(
    request: ChatMessageRequest,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Send a chat message and get AI response
    """
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
        openai_api_key = os.getenv('OPENAI_API_KEY')
        if not openai_api_key:
            raise HTTPException(status_code=500, detail='OpenAI API key not configured')
        
        # Store user message
        user_msg = await create_chat_message(
            user_id=user_id,
            role='user',
            content=request.message,
            meeting_id=request.meeting_id
        )
        
        # Get conversation history from database if not provided
        conversation_history = request.conversation_history
        if not conversation_history:
            # Load last 20 messages for context
            db_messages = await get_chat_messages(
                user_id=user_id,
                meeting_id=request.meeting_id,
                limit=20
            )
            # Convert to OpenAI format (exclude the message we just created)
            conversation_history = [
                {'role': msg['role'], 'content': msg['content']}
                for msg in db_messages
                if msg['id'] != user_msg['id']
            ]
        
        # Generate AI response
        service = ChatPanelService(openai_api_key)
        response_text = await service.generate_response(
            message=request.message,
            conversation_history=conversation_history,
            meetings=request.meetings or []
        )
        
        # Store AI response
        assistant_msg = await create_chat_message(
            user_id=user_id,
            role='assistant',
            content=response_text,
            meeting_id=request.meeting_id
        )
        
        return {
            'success': True,
            'message': response_text,
            'user_message': user_msg,
            'assistant_message': assistant_msg
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Error sending chat message: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=f'Failed to send message: {str(e)}')


@router.delete('/chat/messages/{message_id}')
async def delete_message(
    message_id: str,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Delete a chat message
    """
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
        # Verify message belongs to user (by checking if it exists in user's messages)
        messages = await get_chat_messages(user_id=user_id, limit=1000)
        message_ids = [msg['id'] for msg in messages]
        
        if message_id not in message_ids:
            raise HTTPException(status_code=404, detail='Message not found')
        
        success = await delete_chat_message(message_id)
        
        if success:
            return {'success': True}
        else:
            raise HTTPException(status_code=500, detail='Failed to delete message')
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Error deleting chat message: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=f'Failed to delete message: {str(e)}')

