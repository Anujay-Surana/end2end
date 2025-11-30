"""
Device Registration Routes

Endpoints for registering and managing push notification devices
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any
from app.middleware.auth import require_auth
from app.db.queries.devices import register_device, get_user_devices, unregister_device, get_device_by_token
from app.services.logger import logger

router = APIRouter()


class DeviceRegistrationRequest(BaseModel):
    device_token: str
    platform: str = 'ios'
    timezone: str = 'UTC'
    device_info: Optional[Dict[str, Any]] = None


@router.post('/devices/register')
async def register_device_endpoint(
    request: DeviceRegistrationRequest,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Register a device for push notifications
    """
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
        # Validate platform
        if request.platform not in ['ios', 'android']:
            raise HTTPException(status_code=400, detail='Invalid platform. Must be "ios" or "android"')
        
        # Register device
        device = await register_device(
            user_id=user_id,
            device_token=request.device_token,
            platform=request.platform,
            timezone=request.timezone,
            device_info=request.device_info
        )
        
        logger.info(f'Device registered for user {user_id}', device_id=device.get('id'), platform=request.platform)
        
        return {
            'success': True,
            'device': device
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Error registering device: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=f'Failed to register device: {str(e)}')


@router.get('/devices')
async def get_devices(
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Get all devices for the current user
    """
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
        devices = await get_user_devices(user_id)
        
        return {
            'success': True,
            'devices': devices
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Error fetching devices: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=f'Failed to fetch devices: {str(e)}')


@router.delete('/devices/{device_id}')
async def unregister_device_endpoint(
    device_id: str,
    user: Dict[str, Any] = Depends(require_auth)
):
    """
    Unregister a device
    """
    try:
        user_id = user.get('id')
        if not user_id:
            raise HTTPException(status_code=401, detail='User not authenticated')
        
        # Verify device belongs to user
        device = await get_device_by_token(device_id)  # Note: This should be by ID, but we'll check ownership
        user_devices = await get_user_devices(user_id)
        device_ids = [d.get('id') for d in user_devices]
        
        if device_id not in device_ids:
            raise HTTPException(status_code=404, detail='Device not found')
        
        # Unregister
        success = await unregister_device(device_id)
        
        if success:
            logger.info(f'Device unregistered: {device_id}', userId=user_id)
            return {'success': True}
        else:
            raise HTTPException(status_code=500, detail='Failed to unregister device')
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Error unregistering device: {str(e)}', userId=user.get('id'))
        raise HTTPException(status_code=500, detail=f'Failed to unregister device: {str(e)}')

