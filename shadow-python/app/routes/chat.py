"""
Chat Routes

Endpoints for chat messages with database storage and function calling support
Supports both general chat and meeting-specific chat
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Path
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from app.middleware.auth import require_auth
from app.services.chat_panel_service import ChatPanelService
from app.services.function_executor import FunctionExecutor
from app.services.conversation_manager import ConversationManager
from app.services.memory_service import MemoryService
from app.db.queries.chat_messages import create_chat_message, get_chat_messages, delete_chat_message, get_meeting_chat_messages
from app.db.queries.meeting_briefs import get_brief_by_meeting_id
from app.services.logger import logger
from app.routes.day_prep import get_meetings_for_day
from app.routes.meetings import prep_meeting, MeetingPrepRequest
import os
import json
import httpx

router = APIRouter()


class ChatMessageRequest(BaseModel):
    message: str
    conversation_history: Optional[List[Dict[str, str]]] = None
    meetings: Optional[List[Dict[str, Any]]] = None


class MeetingChatRequest(BaseModel):
    message: str


class SaveMessageRequest(BaseModel):
    message: str
    role: str  # 'user' or 'assistant'
    meeting_id: str


@router.get('/chat/messages')
async def get_messages(
    limit: int = Query(100, ge=1, le=500, description='Maximum number of messages'),
    user: Dict[str, Any] = Depends(require_auth)
):
    """Get chat messages for the current user"""
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
        messages = await get_chat_messages(user_id=user_id, limit=limit)
        
        return {'success': True, 'messages': messages}
        
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
    """Send a chat message and get AI response"""
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
        openai_api_key = os.getenv('OPENAI_API_KEY')
        if not openai_api_key:
            raise HTTPException(status_code=500, detail='OpenAI API key not configured')
        
        # Initialize services
        conversation_manager = ConversationManager(window_size=40)
        memory_service = MemoryService()
        service = ChatPanelService(openai_api_key)
        
        # FIX #1: Store user message ONCE in database
        user_msg = await conversation_manager.add_message_to_history(
            user_id=user_id,
            role='user',
            content=request.message
        )
        
        # FIX #8: Get conversation history from DB (includes the message we just stored)
        # Don't try to filter it - let conversation_manager handle everything
        conversation_history = await conversation_manager.get_conversation_history(
            user_id=user_id,
            include_tool_calls=True
        )
        
        # Get user timezone
        from app.db.queries.users import find_user_by_id
        user_obj = await find_user_by_id(user_id)
        user_timezone = user_obj.get('timezone', 'UTC') if user_obj else 'UTC'
        
        # Retrieve relevant memories
        relevant_memories = []
        if memory_service.enabled:
            try:
                relevant_memories = await memory_service.search_memories(
                    user_id=user_id,
                    query=request.message,
                    limit=5
                )
            except Exception as e:
                logger.warning(f'Error retrieving memories: {str(e)}', userId=user_id)
        
        memory_context = memory_service.format_memories_for_context(relevant_memories) if relevant_memories else ""
        
        # Tool call loop
        executed_calls = []
        max_iterations = 5
        iteration = 0
        response_text = None
        
        while iteration < max_iterations:
            iteration += 1
            
            # FIX #2: On first iteration, user message is NOT in history yet from OpenAI's perspective
            # (it's in DB but we pass is_continuation=True after first call)
            response = await service.generate_response(
                message=request.message,
                conversation_history=conversation_history,
                meetings=request.meetings or [],
                user_timezone=user_timezone,
                memory_context=memory_context,
                is_continuation=(iteration > 1)  # Only add user message on first iteration
            )
            
            # If no function calls, we're done
            if not response.get('function_calls'):
                response_text = response.get('content') or 'I couldn\'t process that request.'
                break
            
            function_calls = response['function_calls']
            if not function_calls:
                response_text = response.get('content') or 'I encountered an error.'
                break
            
            # FIX #4: Store assistant message with tool_calls in correct OpenAI format
            tool_calls_for_storage = [
                {
                    'id': fc.get('id'),
                    'type': 'function',
                    'function': fc.get('function', {})
                }
                for fc in function_calls
            ]
            
            # Store assistant message with tool calls
            await conversation_manager.add_message_to_history(
                user_id=user_id,
                role='assistant',
                content=response.get('content') or '',
                metadata={'tool_calls': tool_calls_for_storage}
            )
            
            # Build assistant message for OpenAI format
            assistant_message = {
                'role': 'assistant',
                'content': response.get('content') or '',
                'tool_calls': tool_calls_for_storage
            }
            
            # Add to current conversation history
            conversation_history.append(assistant_message)
            
            # Execute function calls and store results
            for fc in function_calls:
                func_name = fc.get('function', {}).get('name')
                func_args = fc.get('_parsed_arguments', {})
                tool_call_id = fc.get('id')
                
                if not func_name or func_name not in ['get_calendar_by_date', 'generate_meeting_brief']:
                    result = {'error': f'Unknown function: {func_name}'}
                elif not isinstance(func_args, dict):
                    result = {'error': 'Invalid arguments'}
                else:
                    try:
                        executor = FunctionExecutor(user_id, user, user_timezone)
                        exec_result = await executor.execute(func_name, func_args, tool_call_id)
                        result = exec_result.get('result', {})
                        executed_calls.append(exec_result)
                    except Exception as e:
                        logger.error(f'Error executing {func_name}: {str(e)}', userId=user_id)
                        result = {'error': str(e)}
                        executed_calls.append({
                            'function_name': func_name,
                            'tool_call_id': tool_call_id,
                            'result': result
                        })
                
                # FIX #5: Store tool result with raw_role='tool' in metadata
                # DB only allows user/assistant/system, so store as assistant but mark raw_role
                tool_result_content = json.dumps(result)
                await conversation_manager.add_message_to_history(
                    user_id=user_id,
                    role='assistant',  # DB constraint
                    content=tool_result_content,
                    metadata={
                        'raw_role': 'tool',  # The actual role for OpenAI
                        'tool_call_id': tool_call_id,
                        'function_name': func_name,
                        'is_tool_result': True
                    }
                )
                
                # Add tool result to conversation history for next iteration
                tool_message = {
                    'role': 'tool',
                    'tool_call_id': tool_call_id,
                    'name': func_name,
                    'content': tool_result_content
                }
                conversation_history.append(tool_message)
        
        # Handle max iterations exceeded
        if iteration >= max_iterations and response.get('function_calls'):
            response_text = 'I\'ve processed your request but reached the maximum iterations.'
        
        if not response_text or not response_text.strip():
            response_text = 'I\'ve processed your request.'
        
        # Store final assistant response
        assistant_msg = await conversation_manager.add_message_to_history(
            user_id=user_id,
            role='assistant',
            content=response_text
        )
        
        result = {
            'success': True,
            'message': response_text,
            'user_message': user_msg,
            'assistant_message': assistant_msg
        }
        
        if executed_calls:
            result['function_results'] = executed_calls
        
        # Store memory asynchronously
        if memory_service.enabled:
            try:
                import asyncio
                summary = f"User: {request.message} | Assistant: {response_text[:200]}"
                if executed_calls:
                    summary += f" | Functions: {', '.join(fc.get('function_name', '') for fc in executed_calls)}"
                
                asyncio.create_task(
                    memory_service.add_memory(
                        user_id=user_id,
                        content=summary,
                        metadata={'has_function_calls': bool(executed_calls)}
                    )
                )
            except Exception as e:
                logger.warning(f'Error storing memory: {str(e)}', userId=user_id)
        
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
    """Delete a chat message"""
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
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


# ============================================================
# Save Message Only (for voice transcripts)
# ============================================================


@router.post('/chat/save-message')
async def save_chat_message_only(
    request_body: SaveMessageRequest,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Save a chat message without generating AI response.
    Used by voice/realtime to save transcripts and responses to chat history.
    """
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
        # Validate role
        if request_body.role not in ['user', 'assistant']:
            raise HTTPException(status_code=400, detail='Role must be "user" or "assistant"')
        
        # Save message with meeting_id in metadata
        saved_message = await create_chat_message(
            user_id=user_id,
            role=request_body.role,
            content=request_body.message,
            metadata={'meeting_id': request_body.meeting_id, 'source': 'voice_realtime'}
        )
        
        logger.info(
            f'Saved voice message to chat history',
            userId=user_id,
            meetingId=request_body.meeting_id,
            role=request_body.role,
            contentLength=len(request_body.message)
        )
        
        return {
            'success': True,
            'message': saved_message
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Error saving chat message: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=f'Failed to save message: {str(e)}')


# ============================================================
# Meeting-Specific Chat Endpoints
# ============================================================


@router.get('/meetings/{meeting_id}/chat')
async def get_meeting_chat(
    meeting_id: str = Path(..., description='Google Calendar event ID'),
    limit: int = Query(100, ge=1, le=500, description='Maximum number of messages'),
    user: Dict[str, Any] = Depends(require_auth)
):
    """Get chat messages for a specific meeting"""
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
        # Get meeting-specific messages
        messages = await get_meeting_chat_messages(user_id=user_id, meeting_id=meeting_id, limit=limit)
        
        # Also fetch the brief for context
        brief = await get_brief_by_meeting_id(user_id, meeting_id)
        
        return {
            'success': True,
            'messages': messages,
            'meeting_id': meeting_id,
            'brief_available': brief is not None,
            'one_liner': brief.get('one_liner_summary') if brief else None
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Error fetching meeting chat: {str(e)}', userId=user.get('id'), meetingId=meeting_id)
        raise HTTPException(status_code=500, detail=f'Failed to fetch messages: {str(e)}')


@router.post('/meetings/{meeting_id}/chat')
async def send_meeting_chat(
    meeting_id: str = Path(..., description='Google Calendar event ID'),
    request_body: MeetingChatRequest = None,
    user: Dict[str, Any] = Depends(require_auth)
):
    """Send a chat message for a specific meeting with brief context injection"""
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
        openai_api_key = os.getenv('OPENAI_API_KEY')
        if not openai_api_key:
            raise HTTPException(status_code=500, detail='OpenAI API key not configured')
        
        # Initialize services
        conversation_manager = ConversationManager(window_size=40)
        memory_service = MemoryService()
        service = ChatPanelService(openai_api_key)
        
        # Fetch the pre-generated brief for context
        brief = await get_brief_by_meeting_id(user_id, meeting_id)
        brief_context = ""
        
        if brief:
            brief_data = brief.get('brief_data', {})
            one_liner = brief.get('one_liner_summary', '')
            
            # Build context from brief
            brief_context = f"\n\nMEETING CONTEXT:\n"
            brief_context += f"One-liner: {one_liner}\n" if one_liner else ""
            
            if brief_data.get('summary'):
                brief_context += f"Summary: {brief_data['summary'][:500]}\n"
            
            if brief_data.get('purpose'):
                brief_context += f"Purpose: {brief_data['purpose']}\n"
            
            if brief_data.get('attendees'):
                attendee_names = [a.get('name', '') for a in brief_data['attendees'][:5]]
                brief_context += f"Attendees: {', '.join(attendee_names)}\n"
            
            if brief_data.get('recommendations'):
                brief_context += f"Key recommendations: {'; '.join(brief_data['recommendations'][:3])}\n"
            
            logger.info(
                f'Injecting brief context for meeting chat',
                userId=user_id,
                meetingId=meeting_id,
                briefContextLength=len(brief_context)
            )
        
        # Store user message with meeting_id in metadata
        user_msg = await conversation_manager.add_message_to_history(
            user_id=user_id,
            role='user',
            content=request_body.message,
            metadata={'meeting_id': meeting_id}
        )
        
        # Get meeting-specific conversation history
        conversation_history = await conversation_manager.get_meeting_conversation_history(
            user_id=user_id,
            meeting_id=meeting_id,
            include_tool_calls=True
        )
        
        # Get user timezone
        from app.db.queries.users import find_user_by_id
        user_obj = await find_user_by_id(user_id)
        user_timezone = user_obj.get('timezone', 'UTC') if user_obj else 'UTC'
        
        # Retrieve relevant memories
        relevant_memories = []
        if memory_service.enabled:
            try:
                relevant_memories = await memory_service.search_memories(
                    user_id=user_id,
                    query=request_body.message,
                    limit=5
                )
            except Exception as e:
                logger.warning(f'Error retrieving memories: {str(e)}', userId=user_id)
        
        memory_context = memory_service.format_memories_for_context(relevant_memories) if relevant_memories else ""
        
        # Combine brief context with memory context
        combined_context = brief_context + memory_context
        
        # Function call handling loop (similar to regular chat endpoint)
        max_iterations = 5
        response_text = None
        executed_calls = []
        is_continuation = False
        
        for iteration in range(max_iterations):
            # Generate response with brief context
            response = await service.generate_response(
                message=request_body.message,
                conversation_history=conversation_history,
                meetings=[],  # Meeting context comes from brief
                user_timezone=user_timezone,
                memory_context=combined_context,
                is_continuation=is_continuation
            )
            
            function_calls = response.get('function_calls')
            
            # If no function calls, we have the final text response
            if not function_calls:
                response_text = response.get('content') or 'I\'ve processed your request.'
                break
            
            # Store assistant message with tool_calls in correct OpenAI format
            tool_calls_for_storage = [
                {
                    'id': fc.get('id'),
                    'type': 'function',
                    'function': fc.get('function', {})
                }
                for fc in function_calls
            ]
            
            # Store assistant message with tool calls
            await conversation_manager.add_message_to_history(
                user_id=user_id,
                role='assistant',
                content=response.get('content') or '',
                metadata={'tool_calls': tool_calls_for_storage, 'meeting_id': meeting_id}
            )
            
            # Build assistant message for OpenAI format
            assistant_message = {
                'role': 'assistant',
                'content': response.get('content') or '',
                'tool_calls': tool_calls_for_storage
            }
            
            # Add to current conversation history
            conversation_history.append(assistant_message)
            
            # Execute function calls and store results
            for fc in function_calls:
                func_name = fc.get('function', {}).get('name')
                func_args = fc.get('_parsed_arguments', {})
                tool_call_id = fc.get('id')
                
                if not func_name or func_name not in ['get_calendar_by_date', 'generate_meeting_brief']:
                    result = {'error': f'Unknown function: {func_name}'}
                elif not isinstance(func_args, dict):
                    result = {'error': 'Invalid arguments'}
                else:
                    try:
                        executor = FunctionExecutor(user_id, user, user_timezone)
                        exec_result = await executor.execute(func_name, func_args, tool_call_id)
                        result = exec_result.get('result', {})
                        executed_calls.append(exec_result)
                    except Exception as e:
                        logger.error(f'Error executing {func_name}: {str(e)}', userId=user_id)
                        result = {'error': str(e)}
                        executed_calls.append({
                            'function_name': func_name,
                            'tool_call_id': tool_call_id,
                            'result': result
                        })
                
                # Store tool result with raw_role='tool' in metadata
                tool_result_content = json.dumps(result)
                await conversation_manager.add_message_to_history(
                    user_id=user_id,
                    role='assistant',  # DB constraint
                    content=tool_result_content,
                    metadata={
                        'raw_role': 'tool',
                        'tool_call_id': tool_call_id,
                        'function_name': func_name,
                        'is_tool_result': True,
                        'meeting_id': meeting_id
                    }
                )
                
                # Add tool result to conversation history for next iteration
                tool_message = {
                    'role': 'tool',
                    'tool_call_id': tool_call_id,
                    'name': func_name,
                    'content': tool_result_content
                }
                conversation_history.append(tool_message)
            
            # Mark as continuation for next iteration
            is_continuation = True
        
        # Handle max iterations exceeded
        if iteration >= max_iterations - 1 and response.get('function_calls'):
            response_text = 'I\'ve processed your request but reached the maximum iterations.'
        
        if not response_text or not response_text.strip():
            response_text = 'I\'ve processed your request.'
        
        # Store final assistant response with meeting_id
        assistant_msg = await conversation_manager.add_message_to_history(
            user_id=user_id,
            role='assistant',
            content=response_text,
            metadata={'meeting_id': meeting_id}
        )
        
        result = {
            'success': True,
            'message': response_text,
            'user_message': user_msg,
            'assistant_message': assistant_msg,
            'meeting_id': meeting_id
        }
        
        # Store memory asynchronously
        if memory_service.enabled:
            try:
                import asyncio
                summary = f"Meeting {meeting_id} - User: {request_body.message[:100]} | Assistant: {response_text[:100]}"
                
                asyncio.create_task(
                    memory_service.add_memory(
                        user_id=user_id,
                        content=summary,
                        metadata={'meeting_id': meeting_id}
                    )
                )
            except Exception as e:
                logger.warning(f'Error storing memory: {str(e)}', userId=user_id)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Error sending meeting chat: {str(e)}', userId=user.get('id'), meetingId=meeting_id)
        raise HTTPException(status_code=500, detail=f'Failed to send message: {str(e)}')
