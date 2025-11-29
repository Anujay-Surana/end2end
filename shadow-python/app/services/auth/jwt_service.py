"""
JWT Service Token Generation

Generates JWT tokens for service-to-service authentication
"""

import jwt
import os
from datetime import datetime, timedelta
from typing import Dict, Any, Optional
from app.services.logger import logger
from app.config import settings

# JWT secret key from config
JWT_SECRET = settings.JWT_SECRET
JWT_ALGORITHM = 'HS256'


def generate_service_token(
    user_id: str,
    service_name: str,
    scopes: list[str],
    expires_in_hours: int = 24
) -> str:
    """
    Generate JWT token for service-to-service authentication
    Args:
        user_id: User UUID
        service_name: Service name requesting token
        scopes: List of scopes/permissions
        expires_in_hours: Token expiration in hours
    Returns:
        JWT token string
    """
    payload = {
        'user_id': user_id,
        'service_name': service_name,
        'scopes': scopes,
        'iat': datetime.utcnow(),
        'exp': datetime.utcnow() + timedelta(hours=expires_in_hours),
        'type': 'service_token'
    }
    
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    logger.info(f'Service token generated', serviceName=service_name, userId=user_id)
    return token


def validate_service_token(token: str) -> Dict[str, Any]:
    """
    Validate and decode JWT service token
    Args:
        token: JWT token string
    Returns:
        Decoded token payload
    Raises:
        jwt.ExpiredSignatureError: If token is expired
        jwt.InvalidTokenError: If token is invalid
    """
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        
        # Verify token type
        if payload.get('type') != 'service_token':
            raise jwt.InvalidTokenError('Invalid token type')
        
        return payload
    except jwt.ExpiredSignatureError:
        logger.warning('Service token expired')
        raise
    except jwt.InvalidTokenError as e:
        logger.warning(f'Invalid service token: {str(e)}')
        raise


def has_scope(token_payload: Dict[str, Any], scope: str) -> bool:
    """
    Check if token has a specific scope
    Args:
        token_payload: Decoded token payload
        scope: Scope to check
    Returns:
        True if token has the scope
    """
    scopes = token_payload.get('scopes', [])
    return scope in scopes or '*' in scopes  # '*' means all scopes

