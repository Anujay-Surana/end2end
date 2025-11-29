"""
Service Authentication Middleware

Validates JWT service tokens for microservices
"""

from typing import Optional, Dict, Any
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.services.auth.jwt_service import validate_service_token, has_scope
from app.services.logger import logger

security = HTTPBearer(auto_error=False)


async def validate_service_token_middleware(
    authorization: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> Dict[str, Any]:
    """
    Validate service token from Authorization header
    Args:
        authorization: Bearer token from Authorization header
    Returns:
        Decoded token payload
    Raises:
        HTTPException: If token is missing or invalid
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Service token required'
        )
    
    try:
        token = authorization.credentials
        payload = validate_service_token(token)
        return payload
    except Exception as e:
        logger.warning(f'Service token validation failed: {str(e)}')
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Invalid or expired service token'
        )


async def require_scope(
    scope: str,
    token_payload: Dict[str, Any] = Depends(validate_service_token_middleware)
) -> Dict[str, Any]:
    """
    Require a specific scope in service token
    Args:
        scope: Required scope
        token_payload: Token payload from validate_service_token_middleware
    Returns:
        Token payload
    Raises:
        HTTPException: If token doesn't have required scope
    """
    from app.services.auth.jwt_service import has_scope
    
    if not has_scope(token_payload, scope):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f'Required scope: {scope}'
        )
    
    return token_payload

