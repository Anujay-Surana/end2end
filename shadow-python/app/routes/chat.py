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
    conversation_history: Optional[List[Dict[str, str]]] = None
    meetings: Optional[List[Dict[str, Any]]] = None


@router.get('/chat/messages')
async def get_messages(
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
        
        # Initialize conversation manager with sliding window (last 40 messages for better context)
        conversation_manager = ConversationManager(window_size=40)
        
        # Store user message
        user_msg = await conversation_manager.add_message_to_history(
            user_id=user_id,
            role='user',
            content=request.message
        )
        
        # Get conversation history with sliding window (if not provided)
        conversation_history = request.conversation_history
        if not conversation_history:
            conversation_history = await conversation_manager.get_conversation_history(
                user_id=user_id,
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
        current_history = conversation_history
        executed_calls = []
        max_iterations = 5  # Prevent infinite loops
        iteration = 0
        
        while iteration < max_iterations:
            iteration += 1
            
            # Get response from OpenAI
            # Only include user message on first iteration, subsequent iterations use conversation history
            response = await service.generate_response(
                message=request.message if iteration == 1 else '',
                conversation_history=current_history,
                meetings=request.meetings or [],
                user_timezone=user_timezone,
                memory_context=memory_context
            )
            
            # If no function calls, we're done
            if not response.get('function_calls'):
                response_text = response.get('content') or 'Sorry, I couldn\'t process that request.'
                break
            
            function_calls = response['function_calls']
            if not isinstance(function_calls, list) or len(function_calls) == 0:
                response_text = response.get('content') or 'I encountered an error processing your request.'
                break
            
            # Store the assistant message with tool calls
            tool_calls_content = f"[Function calls: {', '.join([fc.get('name', 'unknown') for fc in function_calls])}]"
            assistant_msg_with_tools = await conversation_manager.add_message_to_history(
                user_id=user_id,
                role='assistant',
                content=response.get('content') or tool_calls_content,
                metadata={
                    'tool_calls': function_calls
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
            
            # Add assistant message to history
            current_history = current_history + [assistant_message_with_tool_calls]
            
            # Track starting point for this iteration's results
            results_start_index = len(executed_calls)
            
            # Execute all function calls sequentially
            for func_call in function_calls:
                func_name = func_call.get('name')
                func_args = func_call.get('arguments', {})
                current_tool_call_id = func_call.get('id', f"call_{len(executed_calls)}")
                
                # Validate function name
                if not func_name or func_name not in ['get_calendar_by_date', 'generate_meeting_brief']:
                    executed_calls.append({
                        'function_name': func_name or 'unknown',
                        'tool_call_id': current_tool_call_id,
                        'result': {'error': f'Unknown function: {func_name}'}
                    })
                    continue
                
                # Validate arguments
                if not isinstance(func_args, dict):
                    executed_calls.append({
                        'function_name': func_name,
                        'tool_call_id': current_tool_call_id,
                        'result': {'error': 'Invalid arguments format'}
                    })
                    continue
                                    
                try:
                    # Execute function sequentially
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
            
            # Store all tool results and add to history
            tool_result_messages = []
            iteration_results = executed_calls[results_start_index:]  # Only new results from this iteration
            for executed_call in iteration_results:
                tool_call_id = executed_call.get('tool_call_id')
                function_name = executed_call.get('function_name')
                result_data = executed_call.get('result', {})
                
                # Store tool result message in database
                # Note: DB only allows 'user', 'assistant', 'system' - store as 'assistant' with tool metadata
                tool_result_content = json.dumps(result_data)
                await conversation_manager.add_message_to_history(
                    user_id=user_id,
                    role='assistant',  # DB constraint - stored as assistant but marked as tool result
                    content=tool_result_content,
                    metadata={
                        'tool_call_id': tool_call_id,
                        'function_name': function_name,
                        'is_tool_result': True
                    }
                )
                
                # Format for OpenAI (as 'tool' role)
                tool_result_messages.append({
                    'role': 'tool',
                    'tool_call_id': tool_call_id,
                    'name': function_name,
                    'content': tool_result_content
                })
            
            # Add tool results to history for next iteration
            current_history = current_history + tool_result_messages
            
            # Continue loop - GPT will see tool results and may make another tool call
            # If GPT doesn't make another tool call, the loop will exit on next iteration
        
        # If we exhausted iterations without getting a final response
        if iteration >= max_iterations and response.get('function_calls'):
            response_text = 'I\'ve processed your request, but reached the maximum number of tool call iterations.'
        
        # Ensure response_text is not None or empty
        if not response_text or not response_text.strip():
            response_text = 'I\'ve processed your request.'
        
        # Store AI response
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
        
        # Include function results if any (for frontend to handle)
        if executed_calls:
            result['function_results'] = executed_calls
        
        # Store conversation summary in mem0.ai for long-term memory (async, don't block response)
        if memory_service.enabled:
            try:
                # Create a summary of this exchange
                summary_parts = [f"User asked: {request.message}"]
                if response_text:
                    summary_parts.append(f"Assistant responded: {response_text[:200]}")
                if executed_calls:
                    func_names = [fc.get('function_name', 'unknown') for fc in executed_calls]
                    summary_parts.append(f"Used functions: {', '.join(func_names)}")
                
                summary = " ".join(summary_parts)
                
                # Store asynchronously (fire and forget)
                import asyncio
                asyncio.create_task(
                    memory_service.add_memory(
                        user_id=user_id,
                        content=summary,
                        metadata={
                            'has_function_calls': bool(executed_calls),
                            'function_names': [fc.get('function_name') for fc in executed_calls] if executed_calls else None
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

