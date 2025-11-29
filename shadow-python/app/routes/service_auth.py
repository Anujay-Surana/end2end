"""
Service Authentication Routes

Endpoints for generating and managing service tokens
"""

from typing import Dict, Any
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from app.middleware.auth import require_auth
from app.services.auth.jwt_service import generate_service_token
from app.services.logger import logger

router = APIRouter()


class GenerateServiceTokenRequest(BaseModel):
    service_name: str
    scopes: list[str]
    expires_in_hours: int = 24


@router.post('/service-token')
async def generate_service_token_endpoint(
    request: GenerateServiceTokenRequest,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Generate JWT token for service-to-service authentication
    Requires user authentication
    """
    try:
        token = generate_service_token(
            user_id=user['id'],
            service_name=request.service_name,
            scopes=request.scopes,
            expires_in_hours=request.expires_in_hours
        )
        
        return {
            'success': True,
            'service_token': token,
            'service_name': request.service_name,
            'scopes': request.scopes
        }
    except Exception as e:
        logger.error(f'Failed to generate service token: {str(e)}')
        raise HTTPException(status_code=500, detail=str(e))

