"""
Devices Database Queries

CRUD operations for devices table
"""

from app.db.connection import supabase
from typing import Dict, List, Any, Optional


async def register_device(
    user_id: str,
    device_token: str,
    platform: str = 'ios',
    timezone: str = 'UTC',
    device_info: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """
    Register or update a device
    Args:
        user_id: User UUID
        device_token: APNs device token
        platform: Platform ('ios' or 'android')
        timezone: Device timezone
        device_info: Optional device info dict
    Returns:
        Registered device
    """
    device_data = {
        'user_id': user_id,
        'device_token': device_token,
        'platform': platform,
        'timezone': timezone,
        'last_active_at': 'now()'
    }
    
    if device_info:
        device_data['device_info'] = device_info
    
    response = supabase.table('devices').upsert(
        device_data,
        on_conflict='device_token'
    ).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to register device: {response.error.message}')
    
    # Query to get the created/updated record
    result = supabase.table('devices').select('*').eq('device_token', device_token).maybe_single().execute()
    
    if result.data:
        return result.data
    raise Exception('Failed to register device')


async def get_user_devices(user_id: str) -> List[Dict[str, Any]]:
    """
    Get all devices for a user
    Args:
        user_id: User UUID
    Returns:
        List of devices
    """
    response = supabase.table('devices').select('*').eq('user_id', user_id).order('last_active_at', desc=True).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return []


async def get_device_by_token(device_token: str) -> Optional[Dict[str, Any]]:
    """
    Get device by token
    Args:
        device_token: APNs device token
    Returns:
        Device or None
    """
    response = supabase.table('devices').select('*').eq('device_token', device_token).maybe_single().execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Database error: {response.error.message}')
    if response.data:
        return response.data
    return None


async def update_device_active_time(device_id: str) -> bool:
    """
    Update device last active time
    Args:
        device_id: Device UUID
    Returns:
        Success
    """
    response = supabase.table('devices').update({'last_active_at': 'now()'}).eq('id', device_id).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to update device: {response.error.message}')
    return True


async def unregister_device(device_id: str) -> bool:
    """
    Unregister a device
    Args:
        device_id: Device UUID
    Returns:
        Success
    """
    response = supabase.table('devices').delete().eq('id', device_id).execute()
    
    if hasattr(response, 'error') and response.error:
        raise Exception(f'Failed to unregister device: {response.error.message}')
    return True

