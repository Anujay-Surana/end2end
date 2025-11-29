"""
Onboarding Routes

Onboarding flow endpoints
"""

from typing import Optional, Dict, Any
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from app.middleware.auth import require_auth
from app.services.onboarding.onboarding_manager import OnboardingManager
from app.services.logger import logger

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

