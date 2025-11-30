"""
User Context Service

Provides centralized user information retrieval and formatting for prompts
Ensures all prompts know who the user is and structure content from their perspective
"""

from typing import Optional, Dict, Any, List
from app.db.queries.accounts import get_primary_account
from app.services.logger import logger


async def get_user_context(user: Optional[Dict[str, Any]], request_id: str = None) -> Optional[Dict[str, Any]]:
    """
    Get user context from user object
    Args:
        user: User object from auth middleware
        request_id: Request ID for logging
    Returns:
        User context object with name, email, and formatted strings
    """
    try:
        if not user:
            logger.warn('No user found - user context unavailable', requestId=request_id)
            return None

        # Extract user info
        user_email = user.get('email')
        user_name = user.get('name') or user_email.split('@')[0] if user_email else 'Unknown'
        
        # Try to get all account emails (for multi-account support)
        account_emails = []
        primary_account_email = user_email
        try:
            if user.get('id'):
                from app.db.queries.accounts import get_accounts_by_user_id
                accounts = await get_accounts_by_user_id(user['id'])
                if accounts:
                    account_emails = [acc.get('account_email') for acc in accounts if acc.get('account_email')]
                    # Get primary account email
                    primary_account = await get_primary_account(user['id'])
                    if primary_account and primary_account.get('account_email'):
                        primary_account_email = primary_account['account_email']
        except Exception as error:
            logger.warn(f'Could not fetch accounts, using user email: {str(error)}', requestId=request_id)

        # Get unique emails (user email + all account emails)
        emails = list(dict.fromkeys([user_email] + account_emails)) if user_email else account_emails

        return {
            'id': user.get('id'),
            'name': user_name,
            'email': user_email,
            'primaryAccountEmail': primary_account_email,
            'formattedName': user_name,
            'formattedEmail': user_email,
            'contextString': f"{user_name} ({user_email})",
            'emails': emails
        }
    except Exception as error:
        logger.error(f'Error getting user context: {str(error)}', requestId=request_id)
        return None


def filter_user_from_attendees(attendees: List[Dict[str, Any]], user_context: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Filter user from attendee list
    Args:
        attendees: Array of attendee objects
        user_context: User context object from get_user_context
    Returns:
        Filtered attendees (excluding user)
    """
    if not user_context or not attendees:
        return attendees or []

    user_emails = [e.lower() for e in user_context.get('emails', [])]
    
    return [
        attendee for attendee in attendees
        if attendee.get('email') or attendee.get('emailAddress')
        if not any(
            user_email == (attendee.get('email') or attendee.get('emailAddress') or '').lower()
            for user_email in user_emails
        )
    ]


def is_user_email(email: str, user_context: Optional[Dict[str, Any]]) -> bool:
    """
    Check if an email belongs to the user
    Args:
        email: Email to check
        user_context: User context object
    Returns:
        True if email belongs to user
    """
    if not user_context or not email:
        return False
    
    user_emails = [e.lower() for e in user_context.get('emails', [])]
    return email.lower() in user_emails


def get_prompt_prefix(user_context: Optional[Dict[str, Any]]) -> str:
    """
    Format user context for prompts
    Args:
        user_context: User context object
    Returns:
        Formatted prefix string for prompts
    """
    if not user_context:
        return ''
    
    return f"You are preparing a brief for {user_context.get('formattedName')} ({user_context.get('formattedEmail')}). "
