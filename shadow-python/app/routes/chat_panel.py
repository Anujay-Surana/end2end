"""
Chat Panel Routes

REST endpoint for chat panel (alternative to WebSocket)
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from app.middleware.auth import require_auth
from app.services.chat_panel_service import ChatPanelService
from app.services.logger import logger
import os

router = APIRouter()


class ChatMessageRequest(BaseModel):
    message: str
    conversation_history: Optional[List[Dict[str, str]]] = None
    meetings: Optional[List[Dict[str, Any]]] = None


@router.post('/chat-panel')
async def chat_panel(
    request: ChatMessageRequest,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Generate chat response using OpenAI
    """
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
        openai_api_key = os.getenv('OPENAI_API_KEY')
        if not openai_api_key:
            raise HTTPException(status_code=500, detail='OpenAI API key not configured')
        
        # Get user timezone for context
        from app.db.queries.users import find_user_by_id
        user_obj = await find_user_by_id(user_id)
        user_timezone = user_obj.get('timezone', 'UTC') if user_obj else 'UTC'
        
        service = ChatPanelService(openai_api_key)
        
        # Get today's meetings if not provided
        meetings = request.meetings
        if not meetings:
            # TODO: Fetch today's meetings from calendar
            meetings = []
        
        response = await service.generate_response(
            message=request.message,
            conversation_history=request.conversation_history or [],
            meetings=meetings,
            user_timezone=user_timezone  # Pass timezone for proper date/time context
        )
        
        return {
            'message': response,
            'success': True
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Chat panel error: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=f'Failed to generate response: {str(e)}')

