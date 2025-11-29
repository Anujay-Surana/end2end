"""
WebSocket Routes

WebSocket endpoints for real-time communication
"""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.services.logger import logger

router = APIRouter()


@router.websocket('/meeting-stream')
async def meeting_stream(websocket: WebSocket):
    """
    WebSocket endpoint for voice conversation
    """
    await websocket.accept()
    logger.info('WebSocket connection established')
    
    try:
        while True:
            data = await websocket.receive_text()
            logger.debug(f'Received WebSocket message: {data[:100]}')
            # TODO: Implement WebSocket message handling
            await websocket.send_text('{"type": "ack"}')
    except WebSocketDisconnect:
        logger.info('WebSocket connection closed')

