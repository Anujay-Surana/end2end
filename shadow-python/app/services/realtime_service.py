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
            if self.openai_ws:
                await self.openai_ws.close()
            self.is_connected = False
            logger.info('Disconnected from OpenAI Realtime API')
        except Exception as e:
            logger.error(f'Error disconnecting: {str(e)}')
    
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
            
            # Send audio.input event
            message = {
                "type": "conversation.item.input_audio_buffer.append",
                "audio": audio_base64
            }
            
            await self.openai_ws.send(json.dumps(message))
            
        except Exception as e:
            logger.error(f'Error sending audio: {str(e)}')
            raise
    
    async def send_text(self, text: str):
        """
        Send text input to OpenAI Realtime API
        
        Args:
            text: Text to send
        """
        if not self.is_connected or not self.openai_ws:
            logger.warning('Cannot send text: not connected to OpenAI Realtime API')
            return
        
        try:
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
            # Create session with 24kHz PCM16 audio format
            session_config = {
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                    "instructions": instructions or "You are Shadow, an executive assistant. Be concise and helpful.",
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
                            "name": "get_calendar_by_date",
                            "description": "Get calendar events for a specific date",
                            "parameters": {
                                "type": "object",
                                "properties": {
                                    "date": {
                                        "type": "string",
                                        "description": "Date in YYYY-MM-DD format"
                                    }
                                },
                                "required": ["date"]
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

