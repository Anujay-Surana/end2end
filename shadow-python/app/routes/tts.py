"""
TTS Routes

Text-to-speech endpoints
"""

from fastapi import APIRouter, Depends
from app.middleware.auth import require_auth
# Rate limiting will be added via middleware
from app.services.logger import logger

router = APIRouter()


@router.post('/tts')
async def text_to_speech(user=Depends(require_auth)):
    """
    Generate speech from text
    """
    # TODO: Implement TTS logic
    logger.info('TTS requested')
    return {'audio': 'Not yet implemented'}

