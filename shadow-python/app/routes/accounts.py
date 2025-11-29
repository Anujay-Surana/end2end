"""
Accounts Routes

Account management endpoints
"""

from fastapi import APIRouter, Depends, HTTPException
from app.middleware.auth import require_auth
from app.db.queries.accounts import get_accounts_by_user_id, delete_account, set_primary_account
# Validation helper - inline for now
def validate_account_id(account_id: str) -> bool:
    """Validate account ID format"""
    return account_id and len(account_id) > 0
from app.services.logger import logger

router = APIRouter()


@router.get('')
async def list_accounts(user: dict = Depends(require_auth)):
    """
    List all connected accounts for current user
    """
    try:
        accounts = await get_accounts_by_user_id(user['id'])

        # Don't expose sensitive tokens to frontend
        sanitized_accounts = [
            {
                'id': account.get('id'),
                'email': account.get('account_email'),
                'name': account.get('account_name'),
                'provider': account.get('provider'),
                'is_primary': account.get('is_primary'),
                'scopes': account.get('scopes'),
                'token_expires_at': account.get('token_expires_at'),
                'created_at': account.get('created_at')
            }
            for account in accounts
        ]

        return {
            'success': True,
            'accounts': sanitized_accounts
        }

    except Exception as error:
        logger.error(f'Get accounts error: {str(error)}')
        raise HTTPException(
            status_code=500,
            detail={
                'error': 'Failed to get accounts',
                'message': str(error)
            }
        )


@router.delete('/{account_id}')
async def delete_account_route(
    account_id: str,
    user: dict = Depends(require_auth)
):
    """
    Delete a connected account
    """
    try:
        # Validate account ID format
        validate_account_id(account_id)

        # Verify account belongs to user
        accounts = await get_accounts_by_user_id(user['id'])
        account = next((a for a in accounts if a.get('id') == account_id), None)

        if not account:
            raise HTTPException(
                status_code=404,
                detail={
                    'error': 'Account not found',
                    'message': 'Account does not exist or does not belong to you'
                }
            )

        # Prevent deletion of primary account if user has multiple accounts
        if account.get('is_primary') and len(accounts) > 1:
            raise HTTPException(
                status_code=400,
                detail={
                    'error': 'Cannot delete primary account',
                    'message': 'Please set another account as primary before deleting this account'
                }
            )

        # Delete account
        await delete_account(account_id)

        logger.info(f"✅ Account removed: {account.get('account_email')} for user {user.get('email')}")

        return {
            'success': True,
            'message': 'Account removed successfully'
        }

    except HTTPException:
        raise
    except Exception as error:
        logger.error(f'Delete account error: {str(error)}')
        raise HTTPException(
            status_code=500,
            detail={
                'error': 'Failed to delete account',
                'message': str(error)
            }
        )


@router.put('/{account_id}/set-primary')
async def set_primary_account_route(
    account_id: str,
    user: dict = Depends(require_auth)
):
    """
    Set an account as primary
    """
    try:
        # Validate account ID format
        validate_account_id(account_id)

        # Verify account belongs to user
        accounts = await get_accounts_by_user_id(user['id'])
        account = next((a for a in accounts if a.get('id') == account_id), None)

        if not account:
            raise HTTPException(
                status_code=404,
                detail={
                    'error': 'Account not found',
                    'message': 'Account does not exist or does not belong to you'
                }
            )

        # Set as primary (DB trigger will unset other primary accounts)
        await set_primary_account(account_id)

        logger.info(f"✅ Primary account updated: {account.get('account_email')} for user {user.get('email')}")

        return {
            'success': True,
            'message': 'Primary account updated successfully',
            'account': {
                'id': account.get('id'),
                'email': account.get('account_email'),
                'is_primary': True
            }
        }

    except HTTPException:
        raise
    except Exception as error:
        logger.error(f'Set primary account error: {str(error)}')
        raise HTTPException(
            status_code=500,
            detail={
                'error': 'Failed to set primary account',
                'message': str(error)
            }
        )
