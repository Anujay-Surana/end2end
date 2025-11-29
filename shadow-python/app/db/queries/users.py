"""
User Database Queries

CRUD operations for users table using Supabase
"""

from app.db.connection import supabase


async def create_user(user_data: dict) -> dict:
    """
    Create a new user
    Args:
        user_data: User data dict with email, name, picture_url
    Returns:
        Created user
    """
    email = user_data.get('email')
    name = user_data.get('name')
    picture_url = user_data.get('picture_url')
    
    # Supabase upsert().select() pattern doesn't work - need to query after upsert
    # First upsert the record
    upsert_response = supabase.table('users').upsert(
        {'email': email, 'name': name, 'picture_url': picture_url},
        on_conflict='email'
    ).execute()
    
    if hasattr(upsert_response, 'error') and upsert_response.error:
        raise Exception(f'Failed to create or update user: {upsert_response.error.message}')
    
    # Then query to get the created/updated record
    response = supabase.table('users').select('*').eq('email', email).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to fetch user: {response.error.message}')
    if response.data:
        return response.data
    raise Exception('Failed to create user')


async def find_user_by_email(email: str) -> dict | None:
    """
    Find user by email
    Args:
        email: User email
    Returns:
        User or None
    """
    response = supabase.table('users').select('*').eq('email', email).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return None


async def find_user_by_id(user_id: str) -> dict | None:
    """
    Find user by ID
    Args:
        user_id: User UUID
    Returns:
        User or None
    """
    response = supabase.table('users').select('*').eq('id', user_id).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return None


async def update_user(user_id: str, updates: dict) -> dict:
    """
    Update user
    Args:
        user_id: User UUID
        updates: Fields to update (name, picture_url)
    Returns:
        Updated user
    """
    name = updates.get('name')
    picture_url = updates.get('picture_url')
    
    # Build update object conditionally (COALESCE logic in Python)
    update_data = {}
    if name is not None:
        update_data['name'] = name
    if picture_url is not None:
        update_data['picture_url'] = picture_url
    
    # Supabase update().eq().select() pattern doesn't work - need to query after update
    # First update the record
    update_response = supabase.table('users').update(update_data).eq('id', user_id).execute()
    
    if hasattr(update_response, 'error') and update_response.error:
        raise Exception(f'Failed to update user: {update_response.error.message}')
    
    # Then query to get the updated record
    response = supabase.table('users').select('*').eq('id', user_id).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to fetch updated user: {response.error.message}')
    if response.data:
        return response.data
    raise Exception('Failed to update user')


async def delete_user(user_id: str) -> bool:
    """
    Delete user (and all associated accounts via CASCADE)
    Args:
        user_id: User UUID
    Returns:
        Success
    """
    response = supabase.table('users').delete().eq('id', user_id).select('id').execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to delete user: {response.error.message}')
    return response.data is not None and len(response.data) > 0

