"""
Onboarding State Management

Tracks onboarding progress per user
"""

from typing import Dict, Any, Optional, List
from datetime import datetime
from app.db.connection import supabase
from app.services.logger import logger


# Onboarding step definitions
ONBOARDING_STEPS = [
    {
        'name': 'welcome',
        'title': 'Welcome to Shadow',
        'description': 'Get started with Shadow',
        'order': 1
    },
    {
        'name': 'connect_google',
        'title': 'Connect Google Account',
        'description': 'Connect your primary Google account',
        'order': 2,
        'required': True
    },
    {
        'name': 'grant_calendar',
        'title': 'Grant Calendar Access',
        'description': 'Allow Shadow to access your calendar',
        'order': 3,
        'required': True
    },
    {
        'name': 'grant_gmail',
        'title': 'Grant Gmail Access',
        'description': 'Allow Shadow to access your emails',
        'order': 4,
        'required': True
    },
    {
        'name': 'grant_drive',
        'title': 'Grant Drive Access',
        'description': 'Allow Shadow to access your documents',
        'order': 5,
        'required': True
    },
    {
        'name': 'connect_additional_accounts',
        'title': 'Connect Additional Accounts',
        'description': 'Add more Google accounts (optional)',
        'order': 6,
        'required': False
    },
    {
        'name': 'build_profile',
        'title': 'Build Your Profile',
        'description': 'Quick profile setup from your emails and web',
        'order': 7,
        'required': False
    },
    {
        'name': 'setup_preferences',
        'title': 'Setup Preferences',
        'description': 'Configure your meeting prep preferences',
        'order': 8,
        'required': False
    }
]


async def get_onboarding_steps() -> List[Dict[str, Any]]:
    """Get all onboarding step definitions"""
    return ONBOARDING_STEPS


async def get_user_onboarding_state(user_id: str) -> Dict[str, Any]:
    """
    Get onboarding state for a user
    Args:
        user_id: User UUID
    Returns:
        Dict with completedSteps, currentStep, progress, etc.
    """
    # Get completed steps from database
    response = supabase.table('onboarding_steps').select('*').eq(
        'user_id', user_id
    ).order('completed_at').execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    
    completed_steps = response.data or []
    completed_step_names = [s['step_name'] for s in completed_steps]
    
    # Find current step (first incomplete step)
    current_step = None
    for step in ONBOARDING_STEPS:
        if step['name'] not in completed_step_names:
            current_step = step
            break
    
    # Calculate progress
    total_steps = len(ONBOARDING_STEPS)
    completed_count = len(completed_steps)
    progress = completed_count / total_steps if total_steps > 0 else 0.0
    
    # Check if onboarding is complete
    is_complete = current_step is None
    
    return {
        'userId': user_id,
        'completedSteps': completed_step_names,
        'currentStep': current_step['name'] if current_step else None,
        'progress': progress,
        'isComplete': is_complete,
        'completedStepsData': completed_steps,
        'nextStep': current_step
    }


async def complete_onboarding_step(
    user_id: str,
    step_name: str,
    data: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Mark an onboarding step as complete
    Args:
        user_id: User UUID
        step_name: Step name to complete
        data: Optional step completion data
    Returns:
        Updated onboarding state
    """
    # Validate step name
    step_def = next((s for s in ONBOARDING_STEPS if s['name'] == step_name), None)
    if not step_def:
        raise ValueError(f'Invalid onboarding step: {step_name}')
    
    # Check if step already completed
    existing = supabase.table('onboarding_steps').select('*').eq(
        'user_id', user_id
    ).eq('step_name', step_name).maybe_single().execute()
    
    if existing.data:
        # Step already completed, update data if provided
        if data:
            supabase.table('onboarding_steps').update({
                'data': data,
                'completed_at': datetime.utcnow().isoformat()
            }).eq('id', existing.data['id']).execute()
        logger.info(f'Onboarding step already completed: {step_name}', userId=user_id)
    else:
        # Mark step as complete
        response = supabase.table('onboarding_steps').insert({
            'user_id': user_id,
            'step_name': step_name,
            'completed_at': datetime.utcnow().isoformat(),
            'data': data or {}
        }).select().execute()
        
        if hasattr(response, 'error') and response.error:
            raise Exception(f'Failed to complete onboarding step: {response.error.message}')
        
        logger.info(f'Onboarding step completed: {step_name}', userId=user_id)
    
    # Return updated state
    return await get_user_onboarding_state(user_id)


async def reset_onboarding(user_id: str) -> Dict[str, Any]:
    """
    Reset onboarding for a user (delete all completed steps)
    Args:
        user_id: User UUID
    Returns:
        Reset onboarding state
    """
    response = supabase.table('onboarding_steps').delete().eq('user_id', user_id).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to reset onboarding: {response.error.message}')
    
    logger.info(f'Onboarding reset', userId=user_id)
    
    return await get_user_onboarding_state(user_id)


async def skip_onboarding_step(
    user_id: str,
    step_name: str
) -> Dict[str, Any]:
    """
    Skip an optional onboarding step
    Args:
        user_id: User UUID
        step_name: Step name to skip
    Returns:
        Updated onboarding state
    """
    step_def = next((s for s in ONBOARDING_STEPS if s['name'] == step_name), None)
    if not step_def:
        raise ValueError(f'Invalid onboarding step: {step_name}')
    
    if step_def.get('required', False):
        raise ValueError(f'Cannot skip required step: {step_name}')
    
    # Mark as skipped (completed with skip flag)
    return await complete_onboarding_step(user_id, step_name, {'skipped': True})

