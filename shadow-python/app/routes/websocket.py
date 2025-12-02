"""
WebSocket Routes

WebSocket endpoints for real-time communication with OpenAI Realtime API
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from app.services.logger import logger
from app.services.realtime_service import RealtimeService
from app.services.function_executor import FunctionExecutor
from app.middleware.auth import optional_auth
from typing import Dict, Any, Optional
import json
import base64
import asyncio

router = APIRouter()


@router.websocket('/realtime')
async def realtime_websocket(websocket: WebSocket):
    """
    WebSocket endpoint for OpenAI Realtime API voice conversation
    
    Handles bidirectional audio streaming and function calls
    """
    await websocket.accept()
    
    # Try to get user from query params or headers (for authentication)
    user_id = 'anonymous'
    user = None
    
    # Check for auth token in query params or headers
    query_params = dict(websocket.query_params)
    auth_token = query_params.get('token') or websocket.headers.get('authorization', '').replace('Bearer ', '')
    
    if auth_token:
        try:
            from app.db.queries.sessions import find_session_by_token
            from app.db.queries.users import find_user_by_id
            
            # Verify session token
            session_obj = await find_session_by_token(auth_token)
            if session_obj:
                user_id_from_session = session_obj.get('user_id')
                if user_id_from_session:
                    user_obj = await find_user_by_id(user_id_from_session)
                    if user_obj:
                        user = user_obj
                        user_id = user.get('id', 'anonymous')
        except Exception as e:
            logger.debug(f'WebSocket auth failed: {str(e)}', userId='anonymous')
            pass  # Continue as anonymous if auth fails
    
    logger.info('Realtime WebSocket connection established', userId=user_id)
    
    realtime_service = None
    function_executor = None
    
    try:
        # Initialize realtime service
        realtime_service = RealtimeService()
        connected = await realtime_service.connect(user_id)
        
        if not connected:
            await websocket.send_json({
                'type': 'error',
                'message': 'Failed to connect to OpenAI Realtime API'
            })
            await websocket.close()
            return
        
        # Initialize function executor if user is authenticated
        if user:
            function_executor = FunctionExecutor(user_id, user)
        
        # Create session
        await realtime_service.create_session(user_id)
        
        # Send ready message
        await websocket.send_json({
            'type': 'realtime_ready',
            'message': 'Connected to OpenAI Realtime API'
        })
        
        # Start receiving messages from OpenAI Realtime API
        receive_task = asyncio.create_task(
            _forward_openai_messages(realtime_service, websocket, user_id)
        )
        
        # Handle messages from client
        try:
            while True:
                # Receive message from client
                try:
                    message = await websocket.receive()
                    
                    if 'text' in message:
                        data = json.loads(message['text'])
                        await _handle_client_message(
                            data, realtime_service, websocket, function_executor, user_id
                        )
                    elif 'bytes' in message:
                        # Binary audio data
                        audio_data = message['bytes']
                        await realtime_service.send_audio(audio_data)
                    
                except WebSocketDisconnect:
                    break
                except Exception as e:
                    logger.error(f'Error handling client message: {str(e)}', userId=user_id)
                    await websocket.send_json({
                        'type': 'error',
                        'message': f'Error processing message: {str(e)}'
                    })
        
        finally:
            receive_task.cancel()
            try:
                await receive_task
            except asyncio.CancelledError:
                pass
            
    except WebSocketDisconnect:
        logger.info('Client WebSocket disconnected', userId=user_id)
    except Exception as e:
        logger.error(f'WebSocket error: {str(e)}', userId=user_id)
        try:
            await websocket.send_json({
                'type': 'error',
                'message': str(e)
            })
        except:
            pass
    finally:
        if realtime_service:
            await realtime_service.disconnect()
        logger.info('Realtime WebSocket connection closed', userId=user_id)


async def _forward_openai_messages(
    realtime_service: RealtimeService,
    websocket: WebSocket,
    user_id: str
):
    """Forward messages from OpenAI Realtime API to client"""
    try:
        async for message in realtime_service.receive_messages():
            msg_type = message.get('type', '')
            
            # Handle different message types
            if msg_type == 'conversation.item.input_audio_transcription.completed':
                # Transcript from user
                transcript = message.get('transcript', '')
                await websocket.send_json({
                    'type': 'realtime_transcript',
                    'text': transcript,
                    'is_final': True
                })
            
            elif msg_type == 'conversation.item.output_audio.delta':
                # Audio chunk from AI
                audio_base64 = message.get('delta', '')
                if audio_base64:
                    await websocket.send_json({
                        'type': 'realtime_audio',
                        'audio': audio_base64
                    })
            
            elif msg_type == 'conversation.item.output_item.added':
                # New output item
                item = message.get('item', {})
                if item.get('type') == 'message':
                    content = item.get('content', [])
                    for part in content:
                        if part.get('type') == 'output_text':
                            text = part.get('text', '')
                            await websocket.send_json({
                                'type': 'realtime_response',
                                'text': text
                            })
            
            elif msg_type == 'response.audio_transcript.delta':
                # Partial transcript
                delta = message.get('delta', '')
                await websocket.send_json({
                    'type': 'realtime_transcript',
                    'text': delta,
                    'is_final': False
                })
            
            elif msg_type == 'response.audio_transcript.done':
                # Final transcript
                transcript = message.get('transcript', '')
                await websocket.send_json({
                    'type': 'realtime_transcript',
                    'text': transcript,
                    'is_final': True
                })
            
            elif msg_type == 'response.function_call_arguments_partial':
                # Function call in progress
                await websocket.send_json({
                    'type': 'realtime_function_call',
                    'function_name': message.get('name', ''),
                    'arguments': message.get('arguments', ''),
                    'status': 'partial'
                })
            
            elif msg_type == 'response.function_call_arguments_done':
                # Function call complete - execute it
                function_name = message.get('name', '')
                arguments_str = message.get('arguments', '{}')
                
                try:
                    arguments = json.loads(arguments_str) if isinstance(arguments_str, str) else arguments_str
                    tool_call_id = message.get('call_id', '')
                    
                    # Execute function if executor is available
                    if function_executor:
                        result = await function_executor.execute(function_name, arguments, tool_call_id)
                        
                        # Send function result back to OpenAI
                        await realtime_service.openai_ws.send(json.dumps({
                            'type': 'response.function_call_output',
                            'call_id': tool_call_id,
                            'output': json.dumps(result.get('result', {}))
                        }))
                        
                        await websocket.send_json({
                            'type': 'realtime_function_result',
                            'function_name': function_name,
                            'result': result.get('result', {})
                        })
                    else:
                        await websocket.send_json({
                            'type': 'realtime_function_call',
                            'function_name': function_name,
                            'status': 'error',
                            'message': 'Function execution not available (not authenticated)'
                        })
                        
                except Exception as e:
                    logger.error(f'Error executing function: {str(e)}', userId=user_id)
                    await websocket.send_json({
                        'type': 'realtime_function_call',
                        'status': 'error',
                        'message': str(e)
                    })
            
            # Forward other message types
            else:
                await websocket.send_json({
                    'type': 'realtime_event',
                    'event': message
                })
                
    except Exception as e:
        logger.error(f'Error forwarding OpenAI messages: {str(e)}', userId=user_id)


async def _handle_client_message(
    data: Dict[str, Any],
    realtime_service: RealtimeService,
    websocket: WebSocket,
    function_executor: Optional[FunctionExecutor],
    user_id: str
):
    """Handle messages from client"""
    msg_type = data.get('type', '')
    
    if msg_type == 'audio':
        # Audio data from client
        audio_base64 = data.get('audio', '')
        if audio_base64:
            try:
                audio_bytes = base64.b64decode(audio_base64)
                await realtime_service.send_audio(audio_bytes)
            except Exception as e:
                logger.error(f'Error sending audio: {str(e)}', userId=user_id)
    
    elif msg_type == 'text':
        # Text message from client
        text = data.get('text', '')
        if text:
            await realtime_service.send_text(text)
    
    elif msg_type == 'stop':
        # Stop generation
        await realtime_service.openai_ws.send(json.dumps({
            'type': 'response.cancel'
        }))
    
    elif msg_type == 'ping':
        # Keep-alive ping
        await websocket.send_json({'type': 'pong'})
    
    else:
        logger.warning(f'Unknown message type: {msg_type}', userId=user_id)

