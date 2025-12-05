"""
WebSocket Routes

WebSocket endpoints for real-time communication with OpenAI Realtime API
Optimized for low-latency binary audio streaming with proper buffering
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from app.services.logger import logger
from app.services.realtime_service import RealtimeService
from app.services.function_executor import FunctionExecutor
from app.middleware.auth import optional_auth
from app.db.queries.meeting_briefs import get_brief_by_meeting_id
from app.db.queries.chat_messages import get_meeting_chat_messages
from typing import Dict, Any, Optional, List
import json
import base64
import asyncio


# =============================================================================
# Context Builder for Realtime Session
# =============================================================================

def build_realtime_context(brief: Optional[Dict], chat_history: List[Dict]) -> str:
    """
    Build system instructions for OpenAI Realtime session from brief and chat history
    
    Args:
        brief: Meeting brief data (from database)
        chat_history: Previous chat messages for this meeting
        
    Returns:
        System instructions string
    """
    instructions = "You are Shadow, an executive assistant helping prepare for a meeting. Be concise, helpful, and conversational.\n\n"
    
    if brief:
        brief_data = brief.get('brief_data', {})
        one_liner = brief.get('one_liner_summary', '')
        
        instructions += "MEETING CONTEXT:\n"
        
        if one_liner:
            instructions += f"- Quick Summary: {one_liner}\n"
        
        if brief_data.get('summary'):
            instructions += f"- Overview: {brief_data['summary'][:500]}\n"
        
        if brief_data.get('purpose'):
            instructions += f"- Purpose: {brief_data['purpose']}\n"
        
        if brief_data.get('agenda'):
            agenda = brief_data['agenda']
            if isinstance(agenda, list):
                instructions += f"- Agenda: {'; '.join(str(item) for item in agenda[:5])}\n"
            else:
                instructions += f"- Agenda: {agenda[:300]}\n"
        
        if brief_data.get('attendees'):
            attendees = brief_data['attendees']
            attendee_info = []
            for a in attendees[:5]:
                name = a.get('name', 'Unknown')
                title = a.get('title', '')
                company = a.get('company', '')
                info = name
                if title:
                    info += f" ({title})"
                if company:
                    info += f" at {company}"
                attendee_info.append(info)
            instructions += f"- Attendees: {', '.join(attendee_info)}\n"
        
        if brief_data.get('recommendations'):
            recs = brief_data['recommendations']
            if isinstance(recs, list):
                instructions += f"- Key Points: {'; '.join(str(r)[:100] for r in recs[:3])}\n"
        
        if brief_data.get('emailAnalysis'):
            instructions += f"- Email Context: {brief_data['emailAnalysis'][:300]}\n"
    
    if chat_history:
        instructions += "\nPREVIOUS CONVERSATION:\n"
        # Include last 10 messages for context
        for msg in chat_history[-10:]:
            role = "User" if msg.get('role') == 'user' else "Assistant"
            content = msg.get('content', '')[:200]
            # Skip tool results from showing in conversation history
            metadata = msg.get('metadata', {})
            if metadata.get('is_tool_result'):
                continue
            instructions += f"{role}: {content}\n"
    
    return instructions

router = APIRouter()


# =============================================================================
# Audio Buffer for batching small audio deltas into playable chunks
# =============================================================================

class AudioBuffer:
    """
    Buffer audio deltas until we have enough for smooth playback.
    OpenAI sends 10-20ms chunks; we buffer to ~100-200ms for AVAudioEngine.
    """
    
    def __init__(self, target_frames: int = 4800):
        """
        Args:
            target_frames: Target buffer size in frames (4800 = 200ms @ 24kHz)
        """
        self.buffer = bytearray()
        self.target_bytes = target_frames * 2  # PCM16 = 2 bytes per frame
    
    def add(self, data: bytes) -> Optional[bytes]:
        """
        Add audio data to buffer. Returns buffered data when target reached.
        
        Args:
            data: Raw PCM16 audio bytes
            
        Returns:
            Buffered audio bytes when target reached, None otherwise
        """
        self.buffer.extend(data)
        if len(self.buffer) >= self.target_bytes:
            result = bytes(self.buffer)
            self.buffer.clear()
            return result
        return None
    
    def flush(self) -> Optional[bytes]:
        """Flush remaining buffer contents."""
        if len(self.buffer) > 0:
            result = bytes(self.buffer)
            self.buffer.clear()
            return result
        return None


# =============================================================================
# Main WebSocket Endpoint
# =============================================================================

@router.websocket('/realtime')
async def realtime_websocket(websocket: WebSocket):
    """
    WebSocket endpoint for OpenAI Realtime API voice conversation
    
    Protocol:
    1. Client connects
    2. Client sends init message: {"type": "init", "audio_format": "pcm16", "sample_rate": 24000}
    3. Server connects to OpenAI and sends ready message
    4. Bidirectional audio/text streaming begins
    """
    await websocket.accept()
    
    user_id = 'anonymous'
    user = None
    
    # Authenticate user from query params or headers
    query_params = dict(websocket.query_params)
    auth_token = query_params.get('token') or websocket.headers.get('authorization', '').replace('Bearer ', '')
    
    if auth_token:
        try:
            from app.db.queries.sessions import find_session_by_token
            from app.db.queries.users import find_user_by_id
            
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
    
    # Get meeting_id from query params for context injection
    meeting_id = query_params.get('meeting_id')
    
    logger.info('Realtime WebSocket connection established', userId=user_id, meetingId=meeting_id)
    logger.info(f'🔌 WebSocket params: token={bool(auth_token)}, meeting_id={meeting_id}', userId=user_id)
    
    realtime_service = None
    function_executor = None
    keepalive_task = None
    receive_task = None
    audio_buffer = AudioBuffer(target_frames=4800)  # 200ms @ 24kHz
    
    try:
        # STEP 1: Wait for optional init message (with timeout)
        # This allows client to declare audio format, but we don't require it for backwards compat
        client_config = {'audio_format': 'pcm16', 'sample_rate': 24000}
        try:
            first_msg = await asyncio.wait_for(websocket.receive(), timeout=2.0)
            if 'text' in first_msg:
                data = json.loads(first_msg['text'])
                if data.get('type') == 'init':
                    client_config['audio_format'] = data.get('audio_format', 'pcm16')
                    client_config['sample_rate'] = data.get('sample_rate', 24000)
                    logger.info(f'Client init: {client_config}', userId=user_id)
        except asyncio.TimeoutError:
            # No init message, continue with defaults
            pass
        
        # STEP 1.5: Fetch meeting context if meeting_id provided
        realtime_context = None
        if meeting_id and user:
            logger.info(f'📋 Fetching meeting context for meeting_id={meeting_id}', userId=user_id)
            try:
                brief = await get_brief_by_meeting_id(user_id, meeting_id)
                chat_history = await get_meeting_chat_messages(user_id, meeting_id, limit=20)
                realtime_context = build_realtime_context(brief, chat_history)
                logger.info(
                    f'✅ Built realtime context for meeting',
                    userId=user_id,
                    meetingId=meeting_id,
                    briefFound=brief is not None,
                    chatHistoryCount=len(chat_history),
                    contextLength=len(realtime_context) if realtime_context else 0
                )
                # Log first 500 chars of context for debugging
                if realtime_context:
                    logger.debug(f'📝 Context preview: {realtime_context[:500]}...', userId=user_id)
            except Exception as e:
                logger.warning(f'❌ Failed to build meeting context: {str(e)}', userId=user_id, meetingId=meeting_id)
        else:
            logger.info(f'⚠️ No meeting context: meeting_id={meeting_id}, user_authenticated={user is not None}', userId=user_id)
        
        # STEP 2: Initialize realtime service and connect to OpenAI
        realtime_service = RealtimeService()
        connected = await realtime_service.connect(user_id)
        
        if not connected:
            await websocket.send_json({
                'type': 'error',
                'message': 'Failed to connect to OpenAI Realtime API'
            })
            await websocket.close()
            return
        
        # Initialize function executor if authenticated
        if user:
            function_executor = FunctionExecutor(user_id, user)
        
        # Create OpenAI session with meeting context (if available)
        await realtime_service.create_session(user_id, instructions=realtime_context)
        
        # STEP 3: Start keepalive task to ping OpenAI
        keepalive_task = asyncio.create_task(
            realtime_service.keepalive()
        )
        
        # Send ready message to client
        await websocket.send_json({
            'type': 'realtime_ready',
            'message': 'Connected to OpenAI Realtime API',
            'config': client_config
        })
        
        # STEP 4: Start receiving messages from OpenAI
        receive_task = asyncio.create_task(
            _forward_openai_messages(realtime_service, websocket, user_id, function_executor, audio_buffer)
        )
        
        # STEP 5: Handle messages from client with timeout for clean shutdown
        running = True
        while running:
            try:
                # Use timeout to allow checking if we should exit
                message = await asyncio.wait_for(websocket.receive(), timeout=1.0)
                
                if 'text' in message:
                    data = json.loads(message['text'])
                    await _handle_client_message(
                        data, realtime_service, websocket, function_executor, user_id
                    )
                elif 'bytes' in message:
                    # Binary audio data - forward directly to OpenAI
                    audio_data = message['bytes']
                    await realtime_service.send_audio(audio_data)
                    
            except asyncio.TimeoutError:
                # No message received, check if we should continue
                if not realtime_service.is_connected:
                    running = False
                continue
            except WebSocketDisconnect:
                running = False
            except Exception as e:
                logger.error(f'Error handling client message: {str(e)}', userId=user_id)
                try:
                    await websocket.send_json({
                        'type': 'error',
                        'message': f'Error processing message: {str(e)}'
                    })
                except:
                    running = False
        
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
        # Clean up tasks
        if keepalive_task:
            keepalive_task.cancel()
            try:
                await keepalive_task
            except asyncio.CancelledError:
                pass
        
        if receive_task:
            receive_task.cancel()
            try:
                await receive_task
            except asyncio.CancelledError:
                pass
        
        # Flush any remaining audio buffer
        if audio_buffer:
            remaining = audio_buffer.flush()
            if remaining:
                try:
                    await websocket.send_bytes(remaining)
                except:
                    pass
        
        if realtime_service:
            await realtime_service.disconnect()
        
        logger.info('Realtime WebSocket connection closed', userId=user_id)


# =============================================================================
# Forward OpenAI Messages to Client
# =============================================================================

async def _forward_openai_messages(
    realtime_service: RealtimeService,
    websocket: WebSocket,
    user_id: str,
    function_executor: Optional[FunctionExecutor],
    audio_buffer: AudioBuffer
):
    """
    Forward messages from OpenAI Realtime API to client.
    
    Audio is buffered and sent as raw binary for low latency.
    Text/control messages are sent as JSON.
    """
    try:
        arg_accumulators: Dict[str, str] = {}

        async for message in realtime_service.receive_messages():
            msg_type = message.get('type', '')
            
            # Log all non-audio messages for debugging
            if msg_type and not msg_type.startswith('response.audio.delta'):
                logger.debug(f'📨 OpenAI → Client: {msg_type}', userId=user_id, messageKeys=list(message.keys()))
            
            # =================================================================
            # AUDIO HANDLING (with buffering)
            # =================================================================
            
            if msg_type == 'response.audio.delta':
                # Audio chunk from AI - buffer before sending
                audio_base64 = message.get('delta', '')
                if audio_base64:
                    try:
                        audio_bytes = base64.b64decode(audio_base64)
                        # Buffer audio until we have enough for smooth playback
                        buffered = audio_buffer.add(audio_bytes)
                        if buffered:
                            await websocket.send_bytes(buffered)
                    except Exception as e:
                        logger.error(f'Error decoding audio delta: {str(e)}', userId=user_id)
            
            elif msg_type == 'response.audio.done':
                # Audio stream complete - flush buffer
                remaining = audio_buffer.flush()
                if remaining:
                    await websocket.send_bytes(remaining)
                await websocket.send_json({'type': 'realtime_audio_done'})
            
            # Handle second audio type: conversation.item.output_audio.added
            elif msg_type == 'conversation.item.output_audio.added':
                item = message.get('item', {})
                audio_base64 = item.get('audio', '')
                if audio_base64:
                    try:
                        audio_bytes = base64.b64decode(audio_base64)
                        # This is typically a complete audio file, send directly
                        await websocket.send_bytes(audio_bytes)
                    except Exception as e:
                        logger.error(f'Error decoding output audio: {str(e)}', userId=user_id)
            
            # =================================================================
            # TRANSCRIPT HANDLING
            # =================================================================
            
            elif msg_type == 'conversation.item.input_audio_transcription.completed':
                # User speech transcript
                transcript = message.get('transcript', '')
                logger.info(f'🎤 User transcript: "{transcript[:100]}..."' if len(transcript) > 100 else f'🎤 User transcript: "{transcript}"', userId=user_id)
                await websocket.send_json({
                    'type': 'realtime_transcript',
                    'text': transcript,
                    'is_final': True,
                    'source': 'user'
                })
            
            elif msg_type == 'response.audio_transcript.delta':
                # Partial AI transcript (live captions)
                delta = message.get('delta', '')
                if delta:
                    await websocket.send_json({
                        'type': 'realtime_transcript',
                        'text': delta,
                        'is_final': False,
                        'source': 'assistant'
                    })
            
            elif msg_type == 'response.audio_transcript.done':
                # Final AI transcript
                transcript = message.get('transcript', '')
                logger.info(f'🤖 Assistant transcript: "{transcript[:100]}..."' if len(transcript) > 100 else f'🤖 Assistant transcript: "{transcript}"', userId=user_id)
                await websocket.send_json({
                    'type': 'realtime_transcript',
                    'text': transcript,
                    'is_final': True,
                    'source': 'assistant'
                })
            
            # =================================================================
            # VAD / INPUT BUFFER EVENTS (forward all input_audio_buffer.*)
            # =================================================================
            
            elif msg_type == 'input_audio_buffer.speech_started':
                await websocket.send_json({
                    'type': 'realtime_speech_started',
                    'audio_start_ms': message.get('audio_start_ms', 0)
                })
            
            elif msg_type == 'input_audio_buffer.speech_stopped':
                await websocket.send_json({
                    'type': 'realtime_speech_stopped',
                    'audio_end_ms': message.get('audio_end_ms', 0)
                })
            
            elif msg_type == 'input_audio_buffer.committed':
                await websocket.send_json({
                    'type': 'realtime_input_committed',
                    'item_id': message.get('item_id', '')
                })
            
            elif msg_type == 'input_audio_buffer.cleared':
                await websocket.send_json({
                    'type': 'realtime_input_cleared'
                })
            
            # =================================================================
            # RESPONSE EVENTS (forward all response.*)
            # =================================================================
            
            elif msg_type == 'response.created':
                await websocket.send_json({
                    'type': 'realtime_response_created',
                    'response_id': message.get('response', {}).get('id', '')
                })
            
            elif msg_type == 'response.done':
                # Flush any remaining audio before signaling done
                remaining = audio_buffer.flush()
                if remaining:
                    await websocket.send_bytes(remaining)
                await websocket.send_json({
                    'type': 'realtime_response_done',
                    'response': message.get('response', {})
                })
                
                # FIX #2: Clear input buffer after response completes
                # This prevents double buffer commits and buffer overflow issues
                await realtime_service.clear_audio_buffer()
            
            elif msg_type == 'response.output_item.added':
                await websocket.send_json({
                    'type': 'realtime_output_item_added',
                    'item': message.get('item', {})
                })
            
            elif msg_type == 'response.output_item.done':
                item = message.get('item', {})
                # Log any transcript found in the output item
                content = item.get('content', [])
                for part in content:
                    if part.get('type') == 'audio' and part.get('transcript'):
                        logger.info(f'🤖 Output item transcript: "{part["transcript"][:100]}..."' if len(part.get('transcript', '')) > 100 else f'🤖 Output item transcript: "{part.get("transcript", "")}"', userId=user_id)
                    elif part.get('type') == 'text' and part.get('text'):
                        logger.info(f'🤖 Output item text: "{part["text"][:100]}..."' if len(part.get('text', '')) > 100 else f'🤖 Output item text: "{part.get("text", "")}"', userId=user_id)
                await websocket.send_json({
                    'type': 'realtime_output_item_done',
                    'item': item
                })
            
            elif msg_type == 'response.content_part.added':
                await websocket.send_json({
                    'type': 'realtime_content_part_added',
                    'part': message.get('part', {})
                })
            
            elif msg_type == 'response.content_part.done':
                part = message.get('part', {})
                # Log any transcript or text in content part
                if part.get('type') == 'audio' and part.get('transcript'):
                    logger.info(f'🤖 Content part transcript: "{part["transcript"][:100]}..."' if len(part.get('transcript', '')) > 100 else f'🤖 Content part transcript: "{part.get("transcript", "")}"', userId=user_id)
                elif part.get('type') == 'text' and part.get('text'):
                    logger.info(f'🤖 Content part text: "{part["text"][:100]}..."' if len(part.get('text', '')) > 100 else f'🤖 Content part text: "{part.get("text", "")}"', userId=user_id)
                await websocket.send_json({
                    'type': 'realtime_content_part_done',
                    'part': part
                })
            
            elif msg_type == 'response.text.delta':
                await websocket.send_json({
                    'type': 'realtime_text_delta',
                    'delta': message.get('delta', '')
                })
            
            elif msg_type == 'response.text.done':
                await websocket.send_json({
                    'type': 'realtime_text_done',
                    'text': message.get('text', '')
                })
            
            # =================================================================
            # CONVERSATION ITEM EVENTS (forward all conversation.item.*)
            # =================================================================
            
            elif msg_type == 'conversation.item.created':
                await websocket.send_json({
                    'type': 'realtime_item_created',
                    'item': message.get('item', {})
                })
            
            elif msg_type == 'conversation.item.truncated':
                await websocket.send_json({
                    'type': 'realtime_item_truncated',
                    'item_id': message.get('item_id', '')
                })
            
            elif msg_type == 'conversation.item.deleted':
                await websocket.send_json({
                    'type': 'realtime_item_deleted',
                    'item_id': message.get('item_id', '')
                })
            
            elif msg_type == 'conversation.item.output_item.added':
                item = message.get('item', {})
                if item.get('type') == 'message':
                    content = item.get('content', [])
                    for part in content:
                        if part.get('type') == 'output_text':
                            await websocket.send_json({
                                'type': 'realtime_response',
                                'text': part.get('text', '')
                            })
            
            # =================================================================
            # FUNCTION CALL HANDLING
            # =================================================================
            
            elif msg_type in ['response.function_call_arguments.delta', 'response.function_call_arguments_delta']:
                call_id = message.get('call_id', '')
                delta = message.get('delta', '')
                if call_id:
                    existing = arg_accumulators.get(call_id, '')
                    arg_accumulators[call_id] = existing + delta
                logger.info('Function call args delta', userId=user_id, callId=call_id, deltaPreview=str(delta)[:200])
            
            elif msg_type in ['response.function_call_arguments_partial', 'response.function_call_arguments.partial']:
                await websocket.send_json({
                    'type': 'realtime_function_call',
                    'function_name': message.get('name', ''),
                    'arguments': message.get('arguments', ''),
                    'status': 'partial'
                })
            
            elif msg_type in ['response.function_call_arguments_done', 'response.function_call_arguments.done']:
                function_name = message.get('name', '')
                arguments_str = message.get('arguments', '{}')
                call_id = message.get('call_id', '')
                
                # Prefer accumulated deltas if present
                if call_id and call_id in arg_accumulators:
                    arguments_str = arg_accumulators.pop(call_id)
                
                try:
                    arguments = json.loads(arguments_str) if isinstance(arguments_str, str) else arguments_str
                    tool_call_id = call_id or message.get('call_id', '')
                    
                    if function_executor:
                        logger.info('Received function call', userId=user_id, functionName=function_name, toolCallId=tool_call_id, argumentsPreview=str(arguments)[:400])
                        result = await function_executor.execute(function_name, arguments, tool_call_id)
                        
                        # Send tool result via conversation.item.create (recommended)
                        tool_output_obj = result.get('result', {}) or {}
                        tool_output_str = json.dumps(tool_output_obj)
                        tool_envelope = {
                            "type": "conversation.item.create",
                            "item": {
                                "type": "function_call_output",
                                "call_id": tool_call_id,
                                "output": tool_output_str
                            }
                        }
                        await realtime_service.openai_ws.send(json.dumps(tool_envelope))
                        logger.info('Sent function_call_output (conversation.item.create)', userId=user_id, functionName=function_name, toolCallId=tool_call_id, outputSize=len(tool_output_str))
                        
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
            
            # =================================================================
            # ERROR HANDLING
            # =================================================================
            
            elif msg_type == 'error':
                logger.info('OpenAI error event', userId=user_id, error=message.get('error', {}))
                await websocket.send_json({
                    'type': 'realtime_error',
                    'error': message.get('error', {})
                })
            
            # =================================================================
            # SESSION EVENTS
            # =================================================================
            
            elif msg_type in ['session.created', 'session.updated']:
                await websocket.send_json({
                    'type': 'realtime_session',
                    'event_type': msg_type,
                    'session': message.get('session', {})
                })
            
            elif msg_type == 'rate_limits.updated':
                await websocket.send_json({
                    'type': 'realtime_rate_limits',
                    'rate_limits': message.get('rate_limits', [])
                })
                
    except Exception as e:
        logger.error(f'Error forwarding OpenAI messages: {str(e)}', userId=user_id)


# =============================================================================
# Handle Client Messages
# =============================================================================

async def _handle_client_message(
    data: Dict[str, Any],
    realtime_service: RealtimeService,
    websocket: WebSocket,
    function_executor: Optional[FunctionExecutor],
    user_id: str
):
    """Handle JSON messages from client"""
    msg_type = data.get('type', '')
    
    # Audio data (base64 encoded - legacy support)
    if msg_type == 'audio':
        audio_base64 = data.get('audio', '')
        if audio_base64:
            try:
                audio_bytes = base64.b64decode(audio_base64)
                await realtime_service.send_audio(audio_bytes)
            except Exception as e:
                logger.error(f'Error sending audio: {str(e)}', userId=user_id)
    
    # Text message
    elif msg_type == 'text':
        text = data.get('text', '')
        if text:
            await realtime_service.send_text(text)
    
    # =================================================================
    # CRITICAL: Forward control messages to OpenAI
    # =================================================================
    
    elif msg_type == 'input_audio_buffer.commit':
        # Client wants to commit audio buffer and trigger response
        await realtime_service.openai_ws.send(json.dumps({
            'type': 'input_audio_buffer.commit'
        }))
    
    elif msg_type == 'input_audio_buffer.clear':
        # Client wants to clear audio buffer
        await realtime_service.openai_ws.send(json.dumps({
            'type': 'input_audio_buffer.clear'
        }))
    
    elif msg_type == 'response.create':
        # Client explicitly requests AI to respond
        response_config = data.get('response', {})
        await realtime_service.openai_ws.send(json.dumps({
            'type': 'response.create',
            'response': response_config
        }))
    
    elif msg_type == 'response.cancel':
        # Cancel current response
        await realtime_service.openai_ws.send(json.dumps({
            'type': 'response.cancel'
        }))
    
    # Legacy stop command
    elif msg_type == 'stop':
        await realtime_service.openai_ws.send(json.dumps({
            'type': 'response.cancel'
        }))
    
    # Ping/pong for keepalive
    elif msg_type == 'ping':
        await websocket.send_json({'type': 'pong'})
    
    # Session update
    elif msg_type == 'session.update':
        await realtime_service.openai_ws.send(json.dumps(data))
    
    # Conversation item operations
    elif msg_type == 'conversation.item.create':
        await realtime_service.openai_ws.send(json.dumps(data))
    
    elif msg_type == 'conversation.item.truncate':
        await realtime_service.openai_ws.send(json.dumps(data))
    
    elif msg_type == 'conversation.item.delete':
        await realtime_service.openai_ws.send(json.dumps(data))
    
    else:
        logger.debug(f'Unhandled client message type: {msg_type}', userId=user_id)
