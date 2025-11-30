"""
Onboarding Manager

High-level onboarding flow management
"""

from typing import Dict, Any, Optional
from app.services.onboarding.onboarding_state import (
    get_user_onboarding_state,
    complete_onboarding_step,
    reset_onboarding,
    skip_onboarding_step,
    get_onboarding_steps,
    ONBOARDING_STEPS
)
from app.services.oauth.oauth_manager import OAuthManager
from app.services.logger import logger


class OnboardingManager:
    """Manages onboarding flows"""
    
    def __init__(self):
        self.oauth_manager = OAuthManager()
    
    async def get_onboarding_status(
        self,
        user_id: str
    ) -> Dict[str, Any]:
        """
        Get current onboarding status for a user
        Args:
            user_id: User UUID
        Returns:
            Onboarding status with current step, progress, etc.
        """
        state = await get_user_onboarding_state(user_id)
        
        # If onboarding is complete, return status
        if state['isComplete']:
            return {
                'status': 'complete',
                'progress': 1.0,
                'completedSteps': state['completedSteps'],
                'message': 'Onboarding complete'
            }
        
        # Get next step details
        next_step = state['nextStep']
        if not next_step:
            return {
                'status': 'complete',
                'progress': 1.0,
                'completedSteps': state['completedSteps']
            }
        
        # Build next step action
        next_step_action = self._build_step_action(next_step, user_id)
        
        return {
            'status': 'in_progress',
            'currentStep': state['currentStep'],
            'progress': state['progress'],
            'completedSteps': state['completedSteps'],
            'nextStep': {
                'name': next_step['name'],
                'title': next_step['title'],
                'description': next_step['description'],
                'required': next_step.get('required', False),
                'action': next_step_action
            }
        }
    
    def _build_step_action(
        self,
        step: Dict[str, Any],
        user_id: str
    ) -> Dict[str, Any]:
        """
        Build action details for a step
        Args:
            step: Step definition
            user_id: User UUID
        Returns:
            Action dict with type, url, etc.
        """
        step_name = step['name']
        
        if step_name == 'connect_google':
            # Initiate OAuth for Google
            oauth_result = self.oauth_manager.initiate_oauth(
                provider_name='google',
                redirect_uri='postmessage',  # For web, use postmessage
                scopes=[
                    'openid',
                    'https://www.googleapis.com/auth/userinfo.email',
                    'https://www.googleapis.com/auth/userinfo.profile'
                ],
                user_id=user_id,
                prompt='consent'
            )
            
            return {
                'type': 'oauth_initiate',
                'provider': 'google',
                'authorizationUrl': oauth_result['authorization_url'],
                'state': oauth_result['state'],
                'scopes': [
                    'openid',
                    'https://www.googleapis.com/auth/userinfo.email',
                    'https://www.googleapis.com/auth/userinfo.profile'
                ]
            }
        
        elif step_name == 'grant_calendar':
            return {
                'type': 'oauth_request_scopes',
                'provider': 'google',
                'scopes': ['https://www.googleapis.com/auth/calendar.readonly'],
                'endpoint': '/auth/google/request-scopes'
            }
        
        elif step_name == 'grant_gmail':
            return {
                'type': 'oauth_request_scopes',
                'provider': 'google',
                'scopes': ['https://www.googleapis.com/auth/gmail.readonly'],
                'endpoint': '/auth/google/request-scopes'
            }
        
        elif step_name == 'grant_drive':
            return {
                'type': 'oauth_request_scopes',
                'provider': 'google',
                'scopes': ['https://www.googleapis.com/auth/drive.readonly'],
                'endpoint': '/auth/google/request-scopes'
            }
        
        elif step_name == 'connect_additional_accounts':
            return {
                'type': 'oauth_initiate',
                'provider': 'google',
                'endpoint': '/auth/google/add-account',
                'optional': True
            }
        
        elif step_name == 'build_profile':
            return {
                'type': 'api_call',
                'endpoint': '/onboarding/build-profile',
                'method': 'POST',
                'description': 'Automatically build your profile from emails and web'
            }
        
        elif step_name == 'setup_preferences':
            return {
                'type': 'form',
                'endpoint': '/onboarding/preferences',
                'fields': [
                    {'name': 'defaultAccount', 'type': 'select', 'label': 'Default Account'},
                    {'name': 'meetingPrepStyle', 'type': 'select', 'label': 'Meeting Prep Style'},
                    {'name': 'notifications', 'type': 'checkbox', 'label': 'Enable Notifications'}
                ]
            }
        
        else:
            return {
                'type': 'manual',
                'endpoint': f'/onboarding/complete-step?step={step_name}'
            }
    
    async def complete_step(
        self,
        user_id: str,
        step_name: str,
        data: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Complete an onboarding step
        Args:
            user_id: User UUID
            step_name: Step name
            data: Step completion data
        Returns:
            Updated onboarding status
        """
        updated_state = await complete_onboarding_step(user_id, step_name, data)
        return await self.get_onboarding_status(user_id)
    
    async def skip_step(
        self,
        user_id: str,
        step_name: str
    ) -> Dict[str, Any]:
        """
        Skip an optional onboarding step
        Args:
            user_id: User UUID
            step_name: Step name
        Returns:
            Updated onboarding status
        """
        await skip_onboarding_step(user_id, step_name)
        return await self.get_onboarding_status(user_id)
    
    async def reset(
        self,
        user_id: str
    ) -> Dict[str, Any]:
        """
        Reset onboarding for a user
        Args:
            user_id: User UUID
        Returns:
            Reset onboarding status
        """
        await reset_onboarding(user_id)
        return await self.get_onboarding_status(user_id)

