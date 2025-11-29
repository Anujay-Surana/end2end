"""
Connected Accounts Database Queries

CRUD operations for connected_accounts table (multiple Google accounts per user) using Supabase
"""

from app.db.connection import supabase


async def create_or_update_account(account_data: dict) -> dict:
    """
    Create or update a connected account
    Args:
        account_data: Account data dict
    Returns:
        Created/updated account
    """
    # Supabase upsert().select() pattern doesn't work - need to query after upsert
    # First upsert the record
    upsert_response = supabase.table('connected_accounts').upsert(
        {
            'user_id': account_data.get('user_id'),
            'provider': account_data.get('provider', 'google'),
            'account_email': account_data.get('account_email'),
            'account_name': account_data.get('account_name'),
            'access_token': account_data.get('access_token'),
            'refresh_token': account_data.get('refresh_token'),
            'token_expires_at': account_data.get('token_expires_at'),
            'scopes': account_data.get('scopes', []),
            'is_primary': account_data.get('is_primary', False)
        },
        on_conflict='user_id,account_email'
    ).execute()
    
    if hasattr(upsert_response, 'error') and upsert_response.error:
        raise Exception(f'Failed to create or update account: {upsert_response.error.message}')
    
    # Then query to get the created/updated record
    response = supabase.table('connected_accounts').select('*').eq(
        'user_id', account_data.get('user_id')
    ).eq('account_email', account_data.get('account_email')).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to fetch account: {response.error.message}')
    if response.data:
        return response.data
    raise Exception('Failed to create or update account')


async def get_accounts_by_user_id(user_id: str) -> list:
    """
    Get all connected accounts for a user
    Args:
        user_id: User UUID
    Returns:
        Array of connected accounts
    """
    response = supabase.table('connected_accounts').select(
        'id, user_id, provider, account_email, account_name, access_token, refresh_token, '
        'token_expires_at, scopes, is_primary, created_at, updated_at'
    ).eq('user_id', user_id).order('is_primary', desc=True).order('created_at').execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    return response.data if response.data else []


async def get_account_by_id(account_id: str) -> dict | None:
    """
    Get a specific account by ID
    Args:
        account_id: Account UUID
    Returns:
        Account or None
    """
    response = supabase.table('connected_accounts').select('*').eq('id', account_id).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return None


async def get_account_by_email(user_id: str, account_email: str) -> dict | None:
    """
    Get account by email and user
    Args:
        user_id: User UUID
        account_email: Account email
    Returns:
        Account or None
    """
    response = supabase.table('connected_accounts').select('*').eq('user_id', user_id).eq(
        'account_email', account_email
    ).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return None


async def get_primary_account(user_id: str) -> dict | None:
    """
    Get primary account for a user
    Args:
        user_id: User UUID
    Returns:
        Primary account or None
    """
    response = supabase.table('connected_accounts').select('*').eq('user_id', user_id).eq(
        'is_primary', True
    ).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return None


async def update_account_token(account_id: str, token_data: dict) -> dict:
    """
    Update account token (after refresh)
    Args:
        account_id: Account UUID
        token_data: New token data with access_token, token_expires_at
    Returns:
        Updated account
    """
    # Supabase update().eq().select() pattern doesn't work - need to query after update
    # First update the record
    update_response = supabase.table('connected_accounts').update({
        'access_token': token_data.get('access_token'),
        'token_expires_at': token_data.get('token_expires_at')
    }).eq('id', account_id).execute()
    
    if hasattr(update_response, 'error') and update_response.error:
        raise Exception(f'Failed to update account token: {update_response.error.message}')
    
    # Then query to get the updated record
    response = supabase.table('connected_accounts').select('*').eq('id', account_id).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to fetch updated account: {response.error.message}')
    if response.data:
        return response.data
    raise Exception('Failed to update account token')


async def set_primary_account(account_id: str) -> dict:
    """
    Set an account as primary (automatically unsets others via trigger)
    Args:
        account_id: Account UUID
    Returns:
        Updated account
    """
    # Supabase update().eq().select() pattern doesn't work - need to query after update
    # First update the record
    update_response = supabase.table('connected_accounts').update({'is_primary': True}).eq('id', account_id).execute()
    
    if hasattr(update_response, 'error') and update_response.error:
        raise Exception(f'Failed to set primary account: {update_response.error.message}')
    
    # Then query to get the updated record
    response = supabase.table('connected_accounts').select('*').eq('id', account_id).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to fetch updated account: {response.error.message}')
    if response.data:
        return response.data
    raise Exception('Failed to set primary account')


async def delete_account(account_id: str) -> bool:
    """
    Delete a connected account
    Args:
        account_id: Account UUID
    Returns:
        Success
    """
    response = supabase.table('connected_accounts').delete().eq('id', account_id).select('id').execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to delete account: {response.error.message}')
    return response.data is not None and len(response.data) > 0


async def count_user_accounts(user_id: str) -> int:
    """
    Count accounts for a user
    Args:
        user_id: User UUID
    Returns:
        Account count
    """
    response = supabase.table('connected_accounts').select('*', count='exact').eq('user_id', user_id).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    return response.count if hasattr(response, 'count') and response.count is not None else 0

