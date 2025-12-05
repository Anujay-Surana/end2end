"""
OpenAI Realtime Service

Handles WebSocket connection to OpenAI Realtime API for low-latency voice conversations
"""

import json
import base64
import asyncio
from typing import Optional, Dict, Any, Callable, AsyncGenerator
from app.config import settings
from app.services.logger import logger
import httpx
import websockets
from websockets.exceptions import ConnectionClosed


class RealtimeService:
    """Service for managing OpenAI Realtime API connections"""
    
    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize realtime service
        
        Args:
            api_key: OpenAI API key (optional, uses config if not provided)
        """
        self.api_key = api_key or settings.OPENAI_API_KEY
        self.realtime_url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17"
        self.openai_ws: Optional[websockets.WebSocketClientProtocol] = None
        self.is_connected = False
        self.conversation_id: Optional[str] = None
        self._keepalive_interval = 20  # seconds
    
    async def connect(self, user_id: str, conversation_id: Optional[str] = None) -> bool:
        """
        Connect to OpenAI Realtime API
        
        Args:
            user_id: User ID
            conversation_id: Optional conversation ID for resuming
            
        Returns:
            Success status
        """
        try:
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "OpenAI-Beta": "realtime=v1"
            }
            
            self.openai_ws = await websockets.connect(
                self.realtime_url,
                additional_headers=headers
            )
            
            self.is_connected = True
            self.conversation_id = conversation_id or f"conv_{user_id}_{asyncio.get_event_loop().time()}"
            
            logger.info(f'Connected to OpenAI Realtime API', userId=user_id, conversation_id=self.conversation_id)
            
            return True
            
        except Exception as e:
            logger.error(f'Error connecting to OpenAI Realtime API: {str(e)}', userId=user_id)
            self.is_connected = False
            return False
    
    async def disconnect(self):
        """Disconnect from OpenAI Realtime API"""
        try:
            self.is_connected = False  # Set first to stop keepalive
            if self.openai_ws:
                await self.openai_ws.close()
            logger.info('Disconnected from OpenAI Realtime API')
        except Exception as e:
            logger.error(f'Error disconnecting: {str(e)}')
    
    async def keepalive(self):
        """
        Send periodic pings to OpenAI to keep connection alive.
        OpenAI Realtime requires pings every ~30 seconds or connection drops.
        """
        while self.is_connected and self.openai_ws:
            try:
                await asyncio.sleep(self._keepalive_interval)
                if self.is_connected and self.openai_ws:
                    await self.openai_ws.ping()
                    logger.debug('Sent keepalive ping to OpenAI')
            except ConnectionClosed:
                logger.info('OpenAI connection closed during keepalive')
                self.is_connected = False
                break
            except Exception as e:
                logger.error(f'Keepalive error: {str(e)}')
                break
    
    async def send_audio(self, audio_data: bytes):
        """
        Send audio data to OpenAI Realtime API
        
        Args:
            audio_data: PCM16 audio data as bytes
        """
        if not self.is_connected or not self.openai_ws:
            logger.warning('Cannot send audio: not connected to OpenAI Realtime API')
            return
        
        try:
            # Convert audio to base64
            audio_base64 = base64.b64encode(audio_data).decode('utf-8')
            
            # FIX #1: Use correct event name (NOT conversation.item.input_audio_buffer.append)
            message = {
                "type": "input_audio_buffer.append",
                "audio": audio_base64
            }
            
            await self.openai_ws.send(json.dumps(message))
            
        except Exception as e:
            logger.error(f'Error sending audio: {str(e)}')
            raise
    
    async def commit_audio_buffer(self):
        """
        Commit the current audio buffer to trigger VAD/transcription.
        Call this after sending audio when using manual turn detection.
        """
        if not self.is_connected or not self.openai_ws:
            return
        
        try:
            await self.openai_ws.send(json.dumps({
                "type": "input_audio_buffer.commit"
            }))
            logger.debug('Committed audio buffer')
        except Exception as e:
            logger.error(f'Error committing audio buffer: {str(e)}')
    
    async def clear_audio_buffer(self):
        """
        Clear the input audio buffer.
        FIX #2: Should be called after response.done to prevent buffer overflow.
        """
        if not self.is_connected or not self.openai_ws:
            return
        
        try:
            await self.openai_ws.send(json.dumps({
                "type": "input_audio_buffer.clear"
            }))
            logger.debug('Cleared audio buffer')
        except Exception as e:
            logger.error(f'Error clearing audio buffer: {str(e)}')
    
    async def cancel_response(self):
        """
        Cancel an in-progress response from the assistant.
        Useful for interruption handling.
        """
        if not self.is_connected or not self.openai_ws:
            return
        
        try:
            await self.openai_ws.send(json.dumps({
                "type": "response.cancel"
            }))
            logger.debug('Cancelled response')
        except Exception as e:
            logger.error(f'Error cancelling response: {str(e)}')
    
    async def create_response(self):
        """
        Explicitly request a response from the assistant.
        Useful when not using VAD or after manual commit.
        """
        if not self.is_connected or not self.openai_ws:
            return
        
        try:
            await self.openai_ws.send(json.dumps({
                "type": "response.create"
            }))
            logger.debug('Requested response creation')
        except Exception as e:
            logger.error(f'Error creating response: {str(e)}')
    
    async def send_text(self, text: str):
        """
        Send text input to OpenAI Realtime API
        
        NOTE (FIX #3): This uses the legacy conversation.item.create syntax.
        The new protocol supports {"type": "input_text", "text": "..."} directly,
        but the legacy format is stable and widely supported. Keeping for compatibility.
        
        Args:
            text: Text to send
        """
        if not self.is_connected or not self.openai_ws:
            logger.warning('Cannot send text: not connected to OpenAI Realtime API')
            return
        
        try:
            # LEGACY SYNTAX (stable, widely supported)
            # New syntax would be: {"type": "input_text", "text": text}
            message = {
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": text
                        }
                    ]
                }
            }
            
            await self.openai_ws.send(json.dumps(message))
            
        except Exception as e:
            logger.error(f'Error sending text: {str(e)}')
            raise
    
    async def create_session(self, user_id: str, instructions: Optional[str] = None) -> Dict[str, Any]:
        """
        Create a new realtime session
        
        Args:
            user_id: User ID
            instructions: Optional system instructions
            
        Returns:
            Session info
        """
        if not self.is_connected or not self.openai_ws:
            await self.connect(user_id)
        
        try:
            # Log tool availability for diagnostics (calendar tokens handled in executor; log Parallel here)
            from app.services.parallel_client import get_parallel_client
            parallel_available = False
            try:
                pc = get_parallel_client()
                parallel_available = bool(pc and pc.is_available())
            except Exception:
                parallel_available = False
            logger.info(
                'Realtime session tool availability',
                userId=user_id,
                parallelAvailable=parallel_available
            )

            tool_guidance = (
                "Tool policy (mandatory):\n"
                "- If the user asks for research, web search, \"find out\", or latest info, you MUST call parallel_search with a clear objective and 2-3 focused queries before responding. "
                "If the tool fails, report the tool error; do NOT say you cannot search without calling the tool.\n"
                "- If the user asks about their calendar (today/this date/what other events/what else today), you MUST call list_calendar_events using the user timezone; use date or start/end if provided; limit 20. "
                "Answer from the tool results.\n"
                "- If you have an event ID and need details, call get_calendar_event.\n"
                "- DO NOT call generate_meeting_brief if a meeting_id/brief is already provided; only use it as a fallback when no brief exists.\n"
                "Always cite which tool you used and base answers on tool outputs."
            )

            instructions_text = instructions or "You are Shadow, an executive assistant. Be concise and helpful."
            instructions_text = f"{instructions_text}\n\nTOOLING GUIDANCE:\n{tool_guidance}"

            # Create session with 24kHz PCM16 audio format
            session_config = {
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                    "instructions": instructions_text,
                    "voice": "alloy",
                    "input_audio_format": "pcm16",
                    "output_audio_format": "pcm16",
                    "input_audio_transcription": {
                        "model": "whisper-1"
                    },
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 700
                    },
                    "tools": [
                        {
                            "type": "function",
                            "name": "list_calendar_events",
                            "description": "List calendar events within a date/time window",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "start_iso": {"type": "string", "description": "Start datetime in ISO8601"},
                                    "end_iso": {"type": "string", "description": "End datetime in ISO8601"},
                                    "date": {"type": "string", "description": "Date in YYYY-MM-DD (uses timezone)"},
                                    "timezone": {"type": "string", "description": "IANA timezone, e.g. America/New_York"},
                                    "limit": {"type": "integer", "description": "Max events to return (1-100)", "minimum": 1, "maximum": 100}
                                }
                            }
                        },
                        {
                            "type": "function",
                            "name": "get_calendar_event",
                            "description": "Fetch a single calendar event by ID",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "event_id": {"type": "string", "description": "Google Calendar event ID"},
                                    "timezone": {"type": "string", "description": "IANA timezone for formatting (optional)"}
                                },
                                "required": ["event_id"]
                            }
                        },
                        {
                            "type": "function",
                            "name": "get_calendar_by_date",
                            "description": "Get calendar events for a specific date",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "date": {
                                        "type": "string",
                                        "description": "Date in YYYY-MM-DD format"
                                    },
                                    "timezone": {
                                        "type": "string",
                                        "description": "IANA timezone, e.g. America/Los_Angeles"
                                    }
                                },
                                "required": ["date"]
                            }
                        },
                        {
                            "type": "function",
                            "name": "parallel_search",
                            "description": "Search the web for information using Parallel AI",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "objective": {"type": "string", "description": "Goal of the search"},
                                    "search_queries": {"type": "array", "items": {"type": "string"}, "description": "List of search queries to run"},
                                    "max_results": {"type": "integer", "description": "Max results to return", "minimum": 1, "maximum": 20},
                                    "max_chars_per_result": {"type": "integer", "description": "Character limit per result", "minimum": 500, "maximum": 5000},
                                    "processor": {"type": "string", "description": "Parallel processor to use", "default": "base"}
                                },
                                "required": ["objective", "search_queries"]
                            }
                        },
                        {
                            "type": "function",
                            "name": "generate_meeting_brief",
                            "description": "Generate a meeting preparation brief",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "meeting_id": {"type": "string"},
                                    "meeting": {"type": "object"}
                                }
                            }
                        }
                    ]
                }
            }
            
            await self.openai_ws.send(json.dumps(session_config))
            
            # Wait for response
            response = await asyncio.wait_for(self.openai_ws.recv(), timeout=5.0)
            response_data = json.loads(response)
            
            logger.info('Created OpenAI Realtime session', userId=user_id)
            
            return response_data
            
        except Exception as e:
            logger.error(f'Error creating session: {str(e)}', userId=user_id)
            raise
    
    async def receive_messages(self) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Receive messages from OpenAI Realtime API
        
        Yields:
            Message dicts
        """
        if not self.is_connected or not self.openai_ws:
            logger.warning('Cannot receive messages: not connected')
            return
        
        try:
            while self.is_connected:
                try:
                    message = await asyncio.wait_for(self.openai_ws.recv(), timeout=1.0)
                    data = json.loads(message)
                    yield data
                except asyncio.TimeoutError:
                    # Send ping to keep connection alive
                    await self.openai_ws.ping()
                    continue
                except ConnectionClosed:
                    logger.info('OpenAI Realtime connection closed')
                    self.is_connected = False
                    break
                except Exception as e:
                    logger.error(f'Error receiving message: {str(e)}')
                    break
                    
        except Exception as e:
            logger.error(f'Error in receive_messages: {str(e)}')
            self.is_connected = False
    
    async def process_audio_chunk(self, audio_base64: str) -> Optional[Dict[str, Any]]:
        """
        Process an audio chunk and get response
        
        Args:
            audio_base64: Base64 encoded PCM16 audio
            
        Returns:
            Response dict or None
        """
        if not self.is_connected or not self.openai_ws:
            return None
        
        try:
            # Send audio
            await self.send_audio(base64.b64decode(audio_base64))
            
            # Wait for response (with timeout)
            try:
                response = await asyncio.wait_for(self.openai_ws.recv(), timeout=5.0)
                return json.loads(response)
            except asyncio.TimeoutError:
                return None
                
        except Exception as e:
            logger.error(f'Error processing audio chunk: {str(e)}')
            return None
