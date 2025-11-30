"""
Enhanced Authentication Routes

OAuth routes with progressive permissions and modular OAuth service
"""

import os
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, Request, Cookie, Response, Query
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel

from app.middleware.auth import require_auth, optional_auth
from app.db.queries.users import create_user, find_user_by_email
from app.db.queries.accounts import create_or_update_account, get_primary_account, get_accounts_by_user_id
from app.db.queries.sessions import create_session
from app.services.oauth.oauth_manager import OAuthManager
from app.services.oauth.google_oauth import GoogleOAuthProvider
from app.services.google_api import fetch_user_profile

# Note: This is an enhanced version of auth routes using the modular OAuth service
# The original auth.py routes are kept for backward compatibility
# New features should use auth_enhanced.py or migrate to it
from app.services.logger import logger

router = APIRouter()
oauth_manager = OAuthManager()
security = HTTPBearer(auto_error=False)


class OAuthCallbackRequest(BaseModel):
    code: str
    state: Optional[str] = None


class RequestScopesRequest(BaseModel):
    scopes: list[str]
    account_id: Optional[str] = None  # If None, uses primary account


@router.post('/google/initiate')
async def initiate_google_oauth(
    redirect_uri: str,
    scopes: list[str],
    user: Optional[Dict[str, Any]] = Depends(optional_auth)
):
    """
    Initiate Google OAuth flow
    Returns authorization URL and state for client to redirect to
    """
    try:
        user_id = user.get('id') if user else None
        
        result = oauth_manager.initiate_oauth(
            provider_name='google',
            redirect_uri=redirect_uri,
            scopes=scopes,
            user_id=user_id,
            prompt='consent'  # Force consent to get refresh_token
        )
        
        return {
            'success': True,
            'authorization_url': result['authorization_url'],
            'state': result['state']
        }
    except Exception as e:
        logger.error(f'Failed to initiate Google OAuth: {str(e)}')
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/google/callback')
async def google_callback(
    request: OAuthCallbackRequest,
    response: Response,
    session: Optional[str] = Cookie(None, alias='session'),
    authorization: Optional[HTTPAuthorizationCredentials] = Depends(security)
):
    """
    Primary sign-in flow: Exchange OAuth code for tokens, create user + session
    Enhanced with modular OAuth service
    """
    try:
        code = request.code
        state = request.state
        
        if not code:
            raise HTTPException(status_code=400, detail='Authorization code required')
        
        # Determine redirect URI based on request origin
        # For web, use postmessage; for mobile, use Railway URL
        capacitor_platform = None
        if hasattr(Request, 'headers'):
            # This is a simplified check - in real implementation, check request headers
            capacitor_platform = None  # TODO: Extract from request headers
        
        is_mobile_request = capacitor_platform in ['ios', 'android']
        
        redirect_uri = 'https://end2end-production.up.railway.app/auth/google/mobile-callback' if is_mobile_request else 'postmessage'
        
        # Exchange code for tokens using OAuth manager
        tokens = await oauth_manager.exchange_code(
            provider_name='google',
            code=code,
            redirect_uri=redirect_uri,
            state=state
        )
        
        access_token = tokens['access_token']
        refresh_token = tokens.get('refresh_token')
        expires_in = tokens.get('expires_in', 3600)
        scope = tokens.get('scope', '')
        
        # Validate access_token
        if not access_token:
            raise HTTPException(status_code=400, detail='No access token received from Google')
        
        # Get user profile with retry logic
        profile = await fetch_user_profile(access_token)
        
        # Create or update user
        user = await create_user({
            'email': profile['email'],
            'name': profile.get('name'),
            'picture_url': profile.get('picture')
        })
        
        logger.info(f'User signed in: {user["email"]}')
        
        # Calculate token expiration
        token_expires_at = datetime.utcnow() + timedelta(seconds=expires_in)
        
        # Create or update account (mark as primary if first account)
        existing_primary = await get_primary_account(user['id'])
        is_primary = not existing_primary
        
        await create_or_update_account({
            'user_id': user['id'],
            'provider': 'google',
            'account_email': profile['email'],
            'account_name': profile.get('name'),
            'access_token': access_token,
            'refresh_token': refresh_token,
            'token_expires_at': token_expires_at.isoformat(),
            'scopes': scope.split(' ') if scope else [],
            'is_primary': is_primary
        })
        
        logger.info(f'Account saved: {profile["email"]} (primary: {is_primary})')
        
        # Create session
        session_obj = await create_session(user['id'], 30)  # 30 days
        
        logger.info(f'Session created for {user["email"]}')
        
        # Set session cookie
        session_token = session_obj['session_token']
        expires_at = datetime.fromisoformat(session_obj['expires_at'])
        max_age = int((expires_at - datetime.utcnow()).total_seconds())
        
        # Determine if we're in production (HTTPS)
        is_production = os.getenv('NODE_ENV') == 'production' or os.getenv('RAILWAY_ENVIRONMENT') is not None
        
        response.set_cookie(
            key='session',
            value=session_token,
            max_age=max_age,
            httponly=True,  # Prevent JavaScript access (security)
            secure=is_production,  # Only send over HTTPS in production
            samesite='lax',  # CSRF protection
            path='/'
        )
        
        return {
            'success': True,
            'user': {
                'id': user['id'],
                'email': user['email'],
                'name': user.get('name'),
                'picture': user.get('picture_url')
            },
            'session': {
                'token': session_token,
                'expires_at': session_obj['expires_at']
            },
            'access_token': access_token,
            'token_expires_at': token_expires_at.isoformat()
        }
    
    except Exception as e:
        logger.error(f'Auth callback error: {str(e)}')
        raise HTTPException(status_code=500, detail=f'Authentication failed: {str(e)}')


@router.get('/google/mobile-callback')
async def mobile_google_callback(
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    error_description: Optional[str] = Query(None),
    request: Request = None
):
    """
    Mobile OAuth callback endpoint
    Handles OAuth redirect from Google to mobile app via deep link
    Accepts code/state from query params (redirect URL) and redirects to app deep link
    """
    try:
        # Handle OAuth errors
        if error:
            error_msg = error_description or error
            logger.error(f'Mobile OAuth error: {error_msg}')
            # Redirect to app with error
            deep_link = f'com.kordn8.shadow://callback?error={error}&error_description={error_msg}'
            return Response(
                content=f'<html><head><meta http-equiv="refresh" content="0;url={deep_link}"></head><body>Redirecting...</body></html>',
                media_type='text/html',
                status_code=302,
                headers={'Location': deep_link}
            )
        
        if not code:
            error_msg = 'No authorization code received'
            logger.error(f'Mobile OAuth callback missing code')
            deep_link = f'com.kordn8.shadow://callback?error=missing_code&error_description={error_msg}'
            return Response(
                content=f'<html><head><meta http-equiv="refresh" content="0;url={deep_link}"></head><body>Redirecting...</body></html>',
                media_type='text/html',
                status_code=302,
                headers={'Location': deep_link}
            )
        
        # Check if client wants JSON response (for testing/debugging)
        accept_header = request.headers.get('accept', '') if request else ''
        wants_json = 'application/json' in accept_header
        
        # Exchange code for tokens using OAuth manager
        redirect_uri = 'https://end2end-production.up.railway.app/auth/google/mobile-callback'
        tokens = await oauth_manager.exchange_code(
            provider_name='google',
            code=code,
            redirect_uri=redirect_uri,
            state=state
        )
        
        access_token = tokens['access_token']
        refresh_token = tokens.get('refresh_token')
        expires_in = tokens.get('expires_in', 3600)
        scope = tokens.get('scope', '')
        
        # Validate access_token
        if not access_token:
            raise HTTPException(status_code=400, detail='No access token received from Google')
        
        # Get user profile
        profile = await fetch_user_profile(access_token)
        
        # Create or update user
        user = await create_user({
            'email': profile['email'],
            'name': profile.get('name'),
            'picture_url': profile.get('picture')
        })
        
        logger.info(f'Mobile user signed in: {user["email"]}')
        
        # Calculate token expiration
        token_expires_at = datetime.utcnow() + timedelta(seconds=expires_in)
        
        # Create or update account (mark as primary if first account)
        existing_primary = await get_primary_account(user['id'])
        is_primary = not existing_primary
        
        await create_or_update_account({
            'user_id': user['id'],
            'provider': 'google',
            'account_email': profile['email'],
            'account_name': profile.get('name'),
            'access_token': access_token,
            'refresh_token': refresh_token,
            'token_expires_at': token_expires_at.isoformat(),
            'scopes': scope.split(' ') if scope else [],
            'is_primary': is_primary
        })
        
        logger.info(f'Mobile account saved: {profile["email"]} (primary: {is_primary})')
        
        # Create session
        session_obj = await create_session(user['id'], 30)  # 30 days
        session_token = session_obj['session_token']
        
        logger.info(f'Mobile session created for {user["email"]}')
        
        # If client wants JSON, return JSON (for testing)
        if wants_json:
            return {
                'success': True,
                'user': {
                    'id': user['id'],
                    'email': user['email'],
                    'name': user.get('name'),
                    'picture': user.get('picture_url')
                },
                'session': {
                    'token': session_token,
                    'expires_at': session_obj['expires_at']
                },
                'access_token': access_token,
                'token_expires_at': token_expires_at.isoformat()
            }
        
        # Redirect to mobile app deep link with session token
        deep_link = f'com.kordn8.shadow://callback?code={code}&session={session_token}&success=true'
        return Response(
            content=f'<html><head><meta http-equiv="refresh" content="0;url={deep_link}"></head><body>Redirecting to app...</body></html>',
            media_type='text/html',
            status_code=302,
            headers={'Location': deep_link}
        )
    
    except Exception as e:
        logger.error(f'Mobile auth callback error: {str(e)}')
        error_msg = str(e)
        deep_link = f'com.kordn8.shadow://callback?error=auth_failed&error_description={error_msg}'
        return Response(
            content=f'<html><head><meta http-equiv="refresh" content="0;url={deep_link}"></head><body>Redirecting...</body></html>',
            media_type='text/html',
            status_code=302,
            headers={'Location': deep_link}
        )


@router.post('/google/add-account')
async def add_google_account(
    request: OAuthCallbackRequest,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Add additional Google account to existing user
    Enhanced with modular OAuth service
    """
    try:
        code = request.code
        user_id = user['id']
        
        if not code:
            raise HTTPException(status_code=400, detail='Authorization code required')
        
        # Exchange code for tokens
        tokens = await oauth_manager.exchange_code(
            provider_name='google',
            code=code,
            redirect_uri='postmessage',
            state=request.state
        )
        
        access_token = tokens['access_token']
        refresh_token = tokens.get('refresh_token')
        expires_in = tokens.get('expires_in', 3600)
        scope = tokens.get('scope', '')
        
        # Get user profile
        profile = await fetch_user_profile(access_token)
        
        # Calculate token expiration
        token_expires_at = datetime.utcnow() + timedelta(seconds=expires_in)
        
        # Add account (not primary - user already has a primary)
        await create_or_update_account({
            'user_id': user_id,
            'provider': 'google',
            'account_email': profile['email'],
            'account_name': profile.get('name'),
            'access_token': access_token,
            'refresh_token': refresh_token,
            'token_expires_at': token_expires_at.isoformat(),
            'scopes': scope.split(' ') if scope else [],
            'is_primary': False
        })
        
        logger.info(f'Additional account added: {profile["email"]} for user {user["email"]}')
        
        return {
            'success': True,
            'user': {
                'id': user['id'],
                'email': user['email'],
                'name': user.get('name'),
                'picture': user.get('picture_url')
            },
            'session': {
                'token': None,  # Add account doesn't create new session
                'expires_at': None
            },
            'access_token': access_token,
            'token_expires_at': token_expires_at.isoformat()
        }
    
    except Exception as e:
        logger.error(f'Add account error: {str(e)}')
        raise HTTPException(status_code=500, detail=f'Failed to add account: {str(e)}')


@router.post('/google/request-scopes')
async def request_additional_scopes(
    request: RequestScopesRequest,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Request additional OAuth scopes for an existing account
    Implements progressive permission requests
    """
    try:
        user_id = user['id']
        requested_scopes = request.scopes
        account_id = request.account_id
        
        # Get account (use primary if account_id not specified)
        if account_id:
            from app.db.queries.accounts import get_account_by_id
            account = await get_account_by_id(account_id)
            if not account or account['user_id'] != user_id:
                raise HTTPException(status_code=404, detail='Account not found')
        else:
            account = await get_primary_account(user_id)
            if not account:
                raise HTTPException(status_code=404, detail='No primary account found')
        
        # Get existing scopes
        existing_scopes = account.get('scopes', []) or []
        
        # Find missing scopes
        missing_scopes = [s for s in requested_scopes if s not in existing_scopes]
        
        if not missing_scopes:
            return {
                'success': True,
                'message': 'All requested scopes already granted',
                'scopes': existing_scopes
            }
        
        # Initiate OAuth flow for additional scopes
        # Use prompt=consent to force re-consent
        oauth_result = oauth_manager.initiate_oauth(
            provider_name='google',
            redirect_uri='postmessage',
            scopes=existing_scopes + missing_scopes,  # Request all scopes (existing + new)
            user_id=user_id,
            prompt='consent'
        )
        
        return {
            'success': True,
            'requiresReauth': True,
            'authorization_url': oauth_result['authorization_url'],
            'state': oauth_result['state'],
            'missingScopes': missing_scopes,
            'message': 'Please re-authenticate to grant additional permissions'
        }
    
    except Exception as e:
        logger.error(f'Failed to request additional scopes: {str(e)}')
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/me')
async def get_current_user(
    user: Optional[Dict[str, Any]] = Depends(optional_auth)
):
    """
    Get current authenticated user
    Returns user info and access token if authenticated
    """
    if not user:
        raise HTTPException(status_code=401, detail='Not authenticated')
    
    try:
        # Get primary account for access token
        primary_account = await get_primary_account(user['id'])
        access_token = primary_account.get('access_token') if primary_account else None
        
        return {
            'user': {
                'id': user['id'],
                'email': user['email'],
                'name': user.get('name'),
                'picture': user.get('picture_url')
            },
            'accessToken': access_token
        }
    except Exception as e:
        logger.error(f'Get current user error: {str(e)}')
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/logout')
async def logout(
    response: Response,
    user: Dict[str, Any] = Depends(require_auth),
    session: Optional[str] = Cookie(None, alias='session')
):
    """
    Delete session (logout) and clear cookie
    """
    try:
        from app.db.queries.sessions import delete_session
        
        session_token = session
        if session_token:
            await delete_session(session_token)
            logger.info(f'User logged out: {user["email"]}')
        
        # Clear session cookie
        response.delete_cookie(
            key='session',
            path='/',
            samesite='lax'
        )
        
        return {'success': True, 'message': 'Logged out successfully'}
    
    except Exception as e:
        logger.error(f'Logout error: {str(e)}')
        raise HTTPException(status_code=500, detail=str(e))

