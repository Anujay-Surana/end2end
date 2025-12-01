"""
Chat Routes

Endpoints for chat messages with database storage and function calling support
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from app.middleware.auth import require_auth
from app.services.chat_panel_service import ChatPanelService
from app.db.queries.chat_messages import create_chat_message, get_chat_messages, delete_chat_message
from app.services.logger import logger
from app.routes.day_prep import get_meetings_for_day
from app.routes.meetings import prep_meeting, MeetingPrepRequest
import os
import json
import httpx

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
        
        # Generate AI response with function calling support
        service = ChatPanelService(openai_api_key)
        response = await service.generate_response(
            message=request.message,
            conversation_history=conversation_history,
            meetings=request.meetings or []
        )
        
        # Handle function calls if any
        function_results = None
        tool_call_id = None
        assistant_message_with_tool_calls = None
        
        if response.get('function_calls'):
            function_calls = response['function_calls']
            logger.info(f'Function calls requested: {[fc["name"] for fc in function_calls]}', userId=user_id)
            
            # Store the assistant message with tool calls for conversation history
            assistant_message_with_tool_calls = {
                'role': 'assistant',
                'content': response.get('content'),  # May be None if only tool calls
                'tool_calls': [
                    {
                        'id': fc['id'],
                        'type': 'function',
                        'function': {
                            'name': fc['name'],
                            'arguments': json.dumps(fc['arguments'])
                        }
                    }
                    for fc in function_calls
                ]
            }
            
            # Execute function calls
            for func_call in function_calls:
                func_name = func_call['name']
                func_args = func_call['arguments']
                tool_call_id = func_call['id']  # Store tool_call_id for response
                
                try:
                    if func_name == 'get_calendar_by_date':
                        # Get calendar for date
                        date = func_args.get('date')
                        if date:
                            # Call the meetings-for-day endpoint logic
                            from datetime import datetime, timezone
                            from app.services.google_api import fetch_calendar_events
                            from app.db.queries.accounts import get_accounts_by_user_id
                            from app.services.token_refresh import ensure_all_tokens_valid
                            from app.services.user_context import get_user_context
                            from app.services.calendar_event_classifier import classify_calendar_event
                            
                            # Parse date
                            year, month, day = map(int, date.split('-'))
                            selected_date = datetime(year, month, day, tzinfo=timezone.utc)
                            start_of_day = selected_date.replace(hour=0, minute=0, second=0, microsecond=0)
                            end_of_day = selected_date.replace(hour=23, minute=59, second=59, microsecond=999999)
                            
                            # Get user accounts
                            accounts = await get_accounts_by_user_id(user_id)
                            await ensure_all_tokens_valid(accounts)
                            valid_accounts = [acc for acc in accounts if acc.get('access_token')]
                            
                            # Fetch meetings
                            all_meetings = []
                            for account in valid_accounts:
                                try:
                                    events = await fetch_calendar_events(
                                        account,
                                        start_of_day.isoformat(),
                                        end_of_day.isoformat(),
                                        100
                                    )
                                    all_meetings.extend(events)
                                except Exception as e:
                                    logger.error(f'Error fetching calendar: {str(e)}')
                            
                            # Format meetings for response
                            formatted_meetings = []
                            for m in all_meetings[:20]:  # Limit to 20
                                start = m.get('start', {}).get('dateTime') or m.get('start', {}).get('date', '')
                                formatted_meetings.append({
                                    'id': m.get('id'),
                                    'summary': m.get('summary', 'Untitled'),
                                    'start': start,
                                    'attendees': [a.get('email', '') for a in m.get('attendees', [])]
                                })
                            
                            function_results = {
                                'function_name': func_name,
                                'tool_call_id': tool_call_id,
                                'result': {
                                    'date': date,
                                    'meetings': formatted_meetings,
                                    'count': len(formatted_meetings)
                                }
                            }
                    
                    elif func_name == 'generate_meeting_brief':
                        # Generate meeting brief
                        meeting_id = func_args.get('meeting_id')
                        meeting_obj = func_args.get('meeting')
                        
                        if not meeting_id and meeting_obj:
                            meeting_id = meeting_obj.get('id')
                        
                        if meeting_id or meeting_obj:
                            # Use the meeting object if provided
                            if meeting_obj:
                                # Return meeting object for frontend to handle brief generation
                                # Frontend will call prep-meeting endpoint directly
                                function_results = {
                                    'function_name': func_name,
                                    'tool_call_id': tool_call_id,
                                    'result': {
                                        'meeting_id': meeting_id or meeting_obj.get('id'),
                                        'status': 'requested',
                                        'message': 'Brief generation requested. The brief will be displayed in a modal.'
                                    },
                                    'meeting': meeting_obj  # Include meeting for frontend to display
                                }
                            else:
                                # If only meeting_id provided, we'd need to fetch meeting details
                                # For now, return error asking for meeting object
                                function_results = {
                                    'function_name': func_name,
                                    'tool_call_id': tool_call_id,
                                    'result': {
                                        'error': 'Meeting object required to generate brief. Please provide meeting details.'
                                    }
                                }
                        else:
                            function_results = {
                                'function_name': func_name,
                                'tool_call_id': tool_call_id,
                                'result': {
                                    'error': 'Meeting ID or meeting object required'
                                }
                            }
                    
                    # If we got function results, break after first call (can extend for multiple)
                    if function_results:
                        break
                        
                except Exception as e:
                    logger.error(f'Error executing function {func_name}: {str(e)}', userId=user_id)
                    function_results = {
                        'function_name': func_name,
                        'tool_call_id': tool_call_id,
                        'result': {'error': f'Error executing function: {str(e)}'}
                    }
            
            # If we executed functions, get final response from OpenAI
            # Add assistant message with tool calls to conversation history
            updated_history = conversation_history + [assistant_message_with_tool_calls] if assistant_message_with_tool_calls else conversation_history
            
            if function_results:
                final_response = await service.generate_response(
                    message=request.message,
                    conversation_history=updated_history,
                    meetings=request.meetings or [],
                    function_results=function_results,
                    tool_call_id=tool_call_id
                )
                response_text = final_response.get('content') or 'I\'ve retrieved the information you requested.'
            else:
                response_text = response.get('content') or 'I encountered an error processing your request.'
        else:
            response_text = response.get('content') or 'Sorry, I couldn\'t process that request.'
        
        # Ensure response_text is not None or empty
        if not response_text or not response_text.strip():
            response_text = 'I\'ve processed your request.'
        
        # Store AI response
        assistant_msg = await create_chat_message(
            user_id=user_id,
            role='assistant',
            content=response_text,
            meeting_id=request.meeting_id
        )
        
        result = {
            'success': True,
            'message': response_text,
            'user_message': user_msg,
            'assistant_message': assistant_msg
        }
        
        # Include function results if any (for frontend to handle)
        if function_results:
            result['function_results'] = function_results
        
        return result
        
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

