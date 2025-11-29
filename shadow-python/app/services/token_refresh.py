"""
Token Refresh Service

Manages OAuth token refresh for Google accounts.
Ensures all access tokens are valid before making API calls.
"""

import os
import asyncio
from datetime import datetime, timedelta
from typing import Dict, Any, List
import httpx
from app.db.queries.accounts import update_account_token
from app.services.logger import logger

# In-memory lock map to prevent concurrent token refreshes for the same account
refresh_locks: Dict[str, asyncio.Lock] = {}


async def acquire_refresh_lock(account_id: str) -> asyncio.Lock:
    """
    Acquire lock for account token refresh
    Args:
        account_id: Account ID
    Returns:
        Lock object
    """
    if account_id not in refresh_locks:
        refresh_locks[account_id] = asyncio.Lock()
    
    return refresh_locks[account_id]


async def refresh_google_token(refresh_token: str) -> Dict[str, Any]:
    """
    Refresh a Google OAuth access token using refresh token
    Args:
        refresh_token: Google refresh token
    Returns:
        Dict with access_token, expires_in
    """
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                'https://oauth2.googleapis.com/token',
                headers={'Content-Type': 'application/x-www-form-urlencoded'},
                data={
                    'client_id': os.getenv('GOOGLE_CLIENT_ID'),
                    'client_secret': os.getenv('GOOGLE_CLIENT_SECRET'),
                    'refresh_token': refresh_token,
                    'grant_type': 'refresh_token'
                }
            )

        if not response.is_success:
            try:
                error_data = response.json()
            except:
                error_data = {}
            
            error_code = error_data.get('error')
            
            # Handle specific Google OAuth errors
            if error_code == 'invalid_grant':
                # Refresh token has been revoked or is invalid
                logger.error('❌ Refresh token invalid_grant error - token likely revoked')
                raise Exception('REVOKED_REFRESH_TOKEN')
            
            error_message = error_data.get('error_description') or error_data.get('error') or f'HTTP {response.status_code}'
            logger.error(f'❌ Failed to refresh token: {error_message}', error_data)
            raise Exception(f'Token refresh failed: {error_message}')

        data = response.json()

        return {
            'access_token': data.get('access_token'),
            'expires_in': data.get('expires_in')  # Usually 3600 seconds (1 hour)
        }
    except Exception as error:
        logger.error(f'Error refreshing Google token: {str(error)}')
        raise


async def ensure_valid_token(account: Dict[str, Any]) -> Dict[str, Any]:
    """
    Ensure an account has a valid access token
    Automatically refreshes if expired or expiring soon (within 5 minutes)
    Args:
        account: Account object with access_token, refresh_token, token_expires_at
    Returns:
        Account object with valid access_token
    """
    # Check if token exists
    if not account.get('access_token'):
        raise Exception(f"No access token for account {account.get('account_email')}")

    # Check if token is expired or expiring soon (within 5 minutes)
    now = datetime.utcnow()
    expires_at_str = account.get('token_expires_at')
    expires_at = datetime.fromisoformat(expires_at_str.replace('Z', '+00:00')) if expires_at_str else None

    # If token_expires_at is NULL, treat as expired (needs refresh)
    # This handles old accounts that don't have expiration set
    is_expired = not expires_at or (expires_at - now < timedelta(minutes=5))

    if not is_expired:
        # Token is still valid
        return account

    # Token is expired or expiring soon - refresh it
    # Use locking to prevent concurrent refreshes
    lock = await acquire_refresh_lock(account.get('id'))
    
    async with lock:
        # Double-check token is still expired after acquiring lock
        # (another request might have refreshed it)
        now_after_lock = datetime.utcnow()
        expires_at_after_lock = datetime.fromisoformat(expires_at_str.replace('Z', '+00:00')) if expires_at_str else None
        still_expired = not expires_at_after_lock or (expires_at_after_lock - now_after_lock < timedelta(minutes=5))
        
        if not still_expired:
            # Token was refreshed by another request, return current account
            return account

        logger.debug(f"🔄 Refreshing token for {account.get('account_email')}")

        if not account.get('refresh_token'):
            raise Exception(f"No refresh token available for account {account.get('account_email')}. User needs to re-authenticate.")

        # Refresh the token
        token_data = await refresh_google_token(account.get('refresh_token'))
        access_token = token_data.get('access_token')
        expires_in = token_data.get('expires_in')

        # Calculate new expiration time
        new_expires_at = datetime.utcnow() + timedelta(seconds=expires_in)

        # Update database with new token
        updated_account = await update_account_token(account.get('id'), {
            'access_token': access_token,
            'token_expires_at': new_expires_at.isoformat()
        })

        logger.info(f"✅ Token refreshed for {account.get('account_email')} (new expiry: {new_expires_at.isoformat()})")

        # Return fresh account object from database (ensures we have latest data)
        return {
            **account,
            'access_token': updated_account.get('access_token'),
            'token_expires_at': updated_account.get('token_expires_at')
        }


async def ensure_all_tokens_valid(accounts: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Ensure all accounts have valid tokens
    Refreshes expired tokens in parallel
    Args:
        accounts: Array of account objects
    Returns:
        Dict with validAccounts, failedAccounts, allSucceeded, partialSuccess
    """
    logger.debug(f"🔐 Validating tokens for {len(accounts)} account(s)...")

    results = await asyncio.gather(*[ensure_valid_token(account) for account in accounts], return_exceptions=True)

    valid_accounts = []
    failed_accounts = []

    for i, result in enumerate(results):
        if isinstance(result, Exception):
            error_message = str(result)
            is_revoked = (
                'REVOKED_TOKEN' in error_message or 
                'invalid_grant' in error_message or
                'REVOKED_REFRESH_TOKEN' in error_message
            )
            
            failed_accounts.append({
                'accountEmail': accounts[i].get('account_email'),
                'accountId': accounts[i].get('id'),
                'error': error_message,
                'isRevoked': is_revoked
            })
        else:
            valid_accounts.append(result)

    if failed_accounts:
        logger.warning(f"⚠️  {len(failed_accounts)} account(s) failed token validation:")
        for failed in failed_accounts:
            logger.warning(f"   - {failed.get('accountEmail')}: {failed.get('error')}")

    logger.debug(f"✅ {len(valid_accounts)}/{len(accounts)} account(s) have valid tokens")

    return {
        'validAccounts': valid_accounts,
        'failedAccounts': failed_accounts,
        'allSucceeded': len(failed_accounts) == 0,
        'partialSuccess': len(valid_accounts) > 0 and len(failed_accounts) > 0
    }

