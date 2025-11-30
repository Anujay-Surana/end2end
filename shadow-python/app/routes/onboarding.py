"""
Onboarding Routes

Onboarding flow endpoints
"""

from typing import Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from app.middleware.auth import require_auth
from app.services.onboarding.onboarding_manager import OnboardingManager
from app.services.onboarding.profile_builder import build_fast_profile
from app.services.parallel_client import get_parallel_client
from app.services.logger import logger
from app.db.queries.accounts import get_accounts_by_user_id
from app.services.multi_account_fetcher import fetch_all_account_context
from app.services.token_refresh import ensure_all_tokens_valid

router = APIRouter()
onboarding_manager = OnboardingManager()


class CompleteStepRequest(BaseModel):
    stepName: str
    data: Optional[Dict[str, Any]] = None


@router.get('/status')
async def get_onboarding_status(user: Dict[str, Any] = Depends(require_auth)):
    """
    Get current onboarding status
    Returns current step, progress, and next step details
    """
    try:
        status = await onboarding_manager.get_onboarding_status(user['id'])
        return status
    except Exception as e:
        logger.error(f'Failed to get onboarding status: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/complete-step')
async def complete_step(
    request: CompleteStepRequest,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Complete an onboarding step
    """
    try:
        status = await onboarding_manager.complete_step(
            user['id'],
            request.stepName,
            request.data
        )
        return status
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f'Failed to complete onboarding step: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/skip-step')
async def skip_step(
    step_name: str,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Skip an optional onboarding step
    """
    try:
        status = await onboarding_manager.skip_step(user['id'], step_name)
        return status
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f'Failed to skip onboarding step: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=str(e))


@router.post('/reset')
async def reset_onboarding(user: Dict[str, Any] = Depends(require_auth)):
    """
    Reset onboarding (delete all completed steps)
    """
    try:
        status = await onboarding_manager.reset(user['id'])
        return status
    except Exception as e:
        logger.error(f'Failed to reset onboarding: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/steps')
async def get_all_steps():
    """
    Get all onboarding step definitions
    """
    from app.services.onboarding.onboarding_state import get_onboarding_steps
    steps = await get_onboarding_steps()
    return {'steps': steps}


@router.post('/build-profile')
async def build_profile_endpoint(user: Dict[str, Any] = Depends(require_auth)):
    """
    Build fast user profile during onboarding
    Target: 5-7 seconds response time
    """
    try:
        # Get parallel client
        parallel_client = get_parallel_client()
        
        # Try to fetch user emails if Gmail access is available
        user_emails = []
        try:
            accounts = await get_accounts_by_user_id(user['id'])
            if accounts:
                # Validate tokens
                token_result = await ensure_all_tokens_valid(accounts)
                valid_accounts = token_result.get('validAccounts', [])
                
                if valid_accounts:
                    # Create a dummy meeting object for email fetching (just need date)
                    from datetime import datetime, timezone, timedelta
                    now = datetime.now(timezone.utc)
                    dummy_meeting = {
                        'summary': 'Profile Building',
                        'start': {'dateTime': now.isoformat()},
                        'description': ''
                    }
                    
                    # Fetch recent emails (limit to 20 for speed)
                    context_result = await fetch_all_account_context(
                        valid_accounts,
                        attendees=[],  # No specific attendees for profile building
                        meeting=dummy_meeting
                    )
                    all_emails = context_result.get('emails', [])
                    
                    # Filter to user's sent emails (most relevant for profile)
                    user_email_lower = user.get('email', '').lower()
                    # Also check all user emails from context
                    user_context = await get_user_context(user)
                    user_emails_list = user_context.get('emails', []) if user_context else [user.get('email')]
                    user_emails_lower = [e.lower() for e in user_emails_list if e]
                    
                    for e in all_emails[:20]:
                        if isinstance(e, dict):
                            from_header = (e.get('from') or '').lower()
                            # Check if any user email appears in from header
                            if any(user_email in from_header for user_email in user_emails_lower):
                                user_emails.append(e)
        except Exception as e:
            logger.warn(f'Could not fetch emails for profile building: {str(e)}', userId=user.get('id'))
            # Continue without emails - web search will still work
        
        # Build profile
        profile = await build_fast_profile(
            user=user,
            user_emails=user_emails if user_emails else None,
            parallel_client=parallel_client,
            request_id=None
        )
        
        # Save profile data to onboarding step
        await onboarding_manager.complete_step(
            user['id'],
            'build_profile',
            {'profile': profile}
        )
        
        return {
            'success': True,
            'profile': profile,
            'message': 'Profile built successfully'
        }
    except Exception as e:
        logger.error(f'Failed to build profile: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=str(e))

