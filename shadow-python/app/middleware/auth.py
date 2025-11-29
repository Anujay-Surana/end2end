"""
Authentication Middleware

Provides authentication middleware to validate session tokens and attach user/account information
"""

from typing import Optional, Dict, Any
from fastapi import Depends, HTTPException, status, Cookie
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.db.queries.sessions import find_session_by_token, extend_session
from app.db.queries.users import find_user_by_id
from app.services.logger import logger

security = HTTPBearer(auto_error=False)


async def require_auth(
    session: Optional[str] = Cookie(None, alias='session'),
    authorization: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> Dict[str, Any]:
    """
    Require authentication - raises 401 if not authenticated
    Args:
        session: Session token from cookie
        authorization: Bearer token from Authorization header (optional)
    Returns:
        User object
    """
    # Try session cookie first, then Authorization header
    session_token = session
    if not session_token and authorization:
        session_token = authorization.credentials

    if not session_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Authentication required'
        )

    # Find session
    session_obj = await find_session_by_token(session_token)
    if not session_obj:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Invalid or expired session'
        )

    # Extend session expiration on each request (sliding expiration)
    try:
        await extend_session(session_token)
    except Exception as error:
        logger.warning(f'Failed to extend session: {str(error)}')
        # Don't fail the request if extension fails

    # Get user
    user_id = session_obj.get('user_id')
    user = await find_user_by_id(user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='User not found'
        )

    return user


async def optional_auth(
    session: Optional[str] = Cookie(None, alias='session'),
    authorization: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> Optional[Dict[str, Any]]:
    """
    Optional authentication - returns user if authenticated, None otherwise
    Args:
        session: Session token from cookie
        authorization: Bearer token from Authorization header (optional)
    Returns:
        User object or None
    """
    try:
        return await require_auth(session, authorization)
    except HTTPException:
        # Expected authentication failure - return None
        return None
    except Exception as e:
        # Unexpected error (database, network, etc.) - log and return None gracefully
        logger.warning(f'Unexpected error in optional_auth: {str(e)}')
        return None


async def get_user_id(user: Dict[str, Any] = Depends(require_auth)) -> str:
    """
    Get user ID from authenticated user
    Args:
        user: User object from require_auth
    Returns:
        User ID
    """
    return user.get('id')


async def is_authenticated(user: Optional[Dict[str, Any]] = Depends(optional_auth)) -> bool:
    """
    Check if user is authenticated
    Args:
        user: User object from optional_auth
    Returns:
        True if authenticated
    """
    return user is not None

