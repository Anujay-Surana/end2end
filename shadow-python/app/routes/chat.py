"""
Chat Routes

Endpoints for chat messages with database storage and function calling support
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from app.middleware.auth import require_auth
from app.services.chat_panel_service import ChatPanelService
from app.services.function_executor import FunctionExecutor
from app.services.conversation_manager import ConversationManager
from app.services.memory_service import MemoryService
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
        
        # Initialize conversation manager with sliding window (last 20 messages)
        conversation_manager = ConversationManager(window_size=20)
        
        # Store user message
        user_msg = await conversation_manager.add_message_to_history(
            user_id=user_id,
            role='user',
            content=request.message,
            meeting_id=request.meeting_id
        )
        
        # Get conversation history with sliding window (if not provided)
        conversation_history = request.conversation_history
        if not conversation_history:
            conversation_history = await conversation_manager.get_conversation_history(
                user_id=user_id,
                meeting_id=request.meeting_id,
                include_tool_calls=True
            )
            # Exclude the message we just created
            conversation_history = [msg for msg in conversation_history if msg.get('content') != request.message]
        
        # Get user timezone for context
        from app.db.queries.users import find_user_by_id
        user_obj = await find_user_by_id(user_id)
        user_timezone = user_obj.get('timezone', 'UTC') if user_obj else 'UTC'
        
        # Retrieve relevant memories from mem0.ai
        memory_service = MemoryService()
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
        
        # Add memory context to system prompt if available
        memory_context = ""
        if relevant_memories:
            memory_context = memory_service.format_memories_for_context(relevant_memories)
        
        # Generate AI response with function calling support
        service = ChatPanelService(openai_api_key)
        response = await service.generate_response(
            message=request.message,
            conversation_history=conversation_history,
            meetings=request.meetings or [],
            user_timezone=user_timezone,
            memory_context=memory_context
        )
        
        # Handle function calls if any
        function_results = None
        tool_call_id = None
        assistant_message_with_tool_calls = None
        
        if response.get('function_calls'):
            function_calls = response['function_calls']
            logger.info(f'Function calls requested: {[fc["name"] for fc in function_calls]}', userId=user_id)
            
            # Validate function calls
            if not isinstance(function_calls, list) or len(function_calls) == 0:
                logger.warning('Invalid function_calls format received', userId=user_id)
                function_calls = []
            
            # Store the assistant message with tool calls for conversation history
            tool_calls_content = f"[Function calls: {', '.join([fc.get('name', 'unknown') for fc in function_calls])}]"
            assistant_msg_with_tools = await conversation_manager.add_message_to_history(
                user_id=user_id,
                role='assistant',
                content=response.get('content') or tool_calls_content,
                meeting_id=request.meeting_id,
                metadata={
                    'function_calls': function_calls,
                    'has_tool_calls': True
                }
            )
            
            assistant_message_with_tool_calls = {
                'role': 'assistant',
                'content': response.get('content') or tool_calls_content,
                'tool_calls': [
                    {
                        'id': fc.get('id', f"call_{idx}"),
                        'type': 'function',
                        'function': {
                            'name': fc.get('name', 'unknown'),
                            'arguments': json.dumps(fc.get('arguments', {})) if isinstance(fc.get('arguments'), dict) else str(fc.get('arguments', ''))
                        }
                    }
                    for idx, fc in enumerate(function_calls)
                ]
            }
            
            # Execute function calls (handle multiple calls sequentially)
            executed_calls = []
            for func_call in function_calls:
                func_name = func_call.get('name')
                func_args = func_call.get('arguments', {})
                current_tool_call_id = func_call.get('id', f"call_{len(executed_calls)}")
                
                # Validate function name
                if not func_name or func_name not in ['get_calendar_by_date', 'generate_meeting_brief']:
                    logger.warning(f'Unknown function called: {func_name}', userId=user_id)
                    executed_calls.append({
                        'function_name': func_name or 'unknown',
                        'tool_call_id': current_tool_call_id,
                        'result': {'error': f'Unknown function: {func_name}'}
                    })
                    continue
                
                # Validate arguments
                if not isinstance(func_args, dict):
                    logger.warning(f'Invalid arguments format for {func_name}: {type(func_args)}', userId=user_id)
                    executed_calls.append({
                        'function_name': func_name,
                        'tool_call_id': current_tool_call_id,
                        'result': {'error': 'Invalid arguments format'}
                    })
                    continue
                
                try:
                    # Use FunctionExecutor to execute the function (pass timezone)
                    executor = FunctionExecutor(user_id, user, user_timezone)
                    result = await executor.execute(func_name, func_args, current_tool_call_id)
                    executed_calls.append(result)
                        
                except Exception as e:
                    logger.error(f'Error executing function {func_name}: {str(e)}', userId=user_id)
                    executed_calls.append({
                        'function_name': func_name or 'unknown',
                        'tool_call_id': current_tool_call_id,
                        'result': {'error': f'Error executing function: {str(e)}'}
                    })
            
            # Use the first successful function result (or first result if all failed)
            # For multiple tool calls, we'll need to handle them properly in the response
            if executed_calls:
                function_results = executed_calls[0]  # Use first result for now
                tool_call_id = function_results.get('tool_call_id')
            
            # If we executed functions, get final response from OpenAI
            # Add assistant message with tool calls to conversation history
            updated_history = conversation_history + [assistant_message_with_tool_calls] if assistant_message_with_tool_calls else conversation_history
            
            # Also add tool result message to conversation history for proper context
            if function_results:
                # Store tool result message in database for conversation history
                # Note: We store as 'assistant' role in DB (for compatibility) but mark as tool result
                # The conversation_manager will convert it to 'tool' role when loading for OpenAI
                tool_result_content = json.dumps(function_results.get('result', {}))
                await conversation_manager.add_message_to_history(
                    user_id=user_id,
                    role='assistant',  # DB stores as assistant, but we'll convert to 'tool' when loading
                    content=tool_result_content,  # Store actual JSON result as content
                    meeting_id=request.meeting_id,
                    metadata={
                        'tool_call_id': tool_call_id,
                        'function_name': function_results.get('function_name'),
                        'function_result': function_results.get('result'),
                        'is_tool_result': True,
                        'role_override': 'tool'  # Flag to convert to 'tool' role when loading
                    }
                )
                
                final_response = await service.generate_response(
                    message=request.message,
                    conversation_history=updated_history,
                    meetings=request.meetings or [],
                    function_results=function_results,
                    tool_call_id=tool_call_id,
                    user_timezone=user_timezone
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
        # If we already stored a message with tool calls, update it or create final response
        if assistant_message_with_tool_calls:
            # Store final response as a new message (or update existing)
            assistant_msg = await conversation_manager.add_message_to_history(
                user_id=user_id,
                role='assistant',
                content=response_text,
                meeting_id=request.meeting_id,
                metadata={
                    'function_results': function_results.get('result') if function_results else None,
                    'function_name': function_results.get('function_name') if function_results else None,
                    'is_function_response': True
                }
            )
        else:
            # Normal response without function calls
            assistant_msg = await conversation_manager.add_message_to_history(
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
        
        # Store conversation summary in mem0.ai for long-term memory (async, don't block response)
        if memory_service.enabled:
            try:
                # Create a summary of this exchange
                summary_parts = [f"User asked: {request.message}"]
                if response_text:
                    summary_parts.append(f"Assistant responded: {response_text[:200]}")
                if function_results:
                    func_name = function_results.get('function_name', 'unknown')
                    summary_parts.append(f"Used function: {func_name}")
                
                summary = " ".join(summary_parts)
                
                # Store asynchronously (fire and forget)
                import asyncio
                asyncio.create_task(
                    memory_service.add_memory(
                        user_id=user_id,
                        content=summary,
                        metadata={
                            'meeting_id': request.meeting_id,
                            'has_function_calls': bool(function_results),
                            'function_name': function_results.get('function_name') if function_results else None
                        }
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

