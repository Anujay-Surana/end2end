"""
APNs Service

Handles sending push notifications to iOS devices via Apple Push Notification service
Uses aioapns library (async, compatible with PyJWT 2.9+)
"""

import os
import json
from typing import Dict, List, Any, Optional
from app.services.logger import logger

# Try to import aioapns (compatible with PyJWT 2.9+)
try:
    from aioapns import APNs, NotificationRequest, PushType
    APNS_AVAILABLE = True
except ImportError as e:
    logger.warning(f'APNs library (aioapns) not available: {str(e)}. Push notifications will be disabled.')
    APNs = None
    NotificationRequest = None
    PushType = None
    APNS_AVAILABLE = False
except Exception as e:
    # Handle any other compatibility issues
    logger.warning(f'APNs library has compatibility issues: {str(e)}. Push notifications will be disabled.')
    APNs = None
    NotificationRequest = None
    PushType = None
    APNS_AVAILABLE = False


class APNsService:
    def __init__(self):
        self.client: Optional[APNs] = None
        self.auth_key_path: Optional[str] = None
        self.auth_key_id: Optional[str] = None
        self.team_id: Optional[str] = None
        self.bundle_id: Optional[str] = None
        self.use_sandbox: bool = True
        self._initialize()
    
    def _initialize(self):
        """Initialize APNs client with credentials"""
        if not APNS_AVAILABLE:
            logger.warn('APNs library (aioapns) not available - push notifications disabled')
            return
            
        try:
            self.auth_key_id = os.getenv('APNS_KEY_ID')
            self.team_id = os.getenv('APNS_TEAM_ID')
            self.bundle_id = os.getenv('APNS_BUNDLE_ID', 'com.kordn8.shadow')
            self.use_sandbox = os.getenv('APNS_USE_SANDBOX', 'true').lower() == 'true'
            
            # Get key content (either from file or environment variable)
            key_path = os.getenv('APNS_KEY_PATH')
            key_content = os.getenv('APNS_KEY_CONTENT')
            
            if not self.auth_key_id or not self.team_id:
                logger.warn('APNs credentials not configured (APNS_KEY_ID, APNS_TEAM_ID)')
                return
            
            if not key_path and not key_content:
                logger.warn('APNs key not configured (APNS_KEY_PATH or APNS_KEY_CONTENT)')
                return
            
            # Determine key path - use file path or create temp file from content
            if key_path and os.path.exists(key_path):
                self.auth_key_path = key_path
            elif key_content:
                # Create temporary file from key content
                import tempfile
                temp_file = tempfile.NamedTemporaryFile(mode='w', suffix='.p8', delete=False)
                temp_file.write(key_content)
                temp_file.close()
                self.auth_key_path = temp_file.name
            else:
                logger.warn('APNs key not found (neither APNS_KEY_PATH nor APNS_KEY_CONTENT provided)')
                return
            
            # Create aioapns client
            self.client = APNs(
                key=self.auth_key_path,
                key_id=self.auth_key_id,
                team_id=self.team_id,
                topic=self.bundle_id,
                use_sandbox=self.use_sandbox
            )
            
            logger.info(f'APNs service initialized (sandbox: {self.use_sandbox}, bundle: {self.bundle_id})')
            
        except Exception as e:
            logger.error(f'Error initializing APNs service: {str(e)}')
            self.client = None
    
    def is_configured(self) -> bool:
        """Check if APNs is properly configured"""
        return self.client is not None
    
    async def send_notification(
        self,
        device_token: str,
        title: str,
        body: str,
        data: Optional[Dict[str, Any]] = None,
        sound: str = 'default',
        badge: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Send a push notification to a device
        Args:
            device_token: APNs device token
            title: Notification title
            body: Notification body
            data: Optional custom data payload
            sound: Sound name (default: 'default')
            badge: Optional badge number
        Returns:
            Dict with status and error (if any)
        """
        if not self.client:
            return {
                'success': False,
                'error': 'APNs not configured'
            }
        
        try:
            # Build payload
            message = {
                'aps': {
                    'alert': {
                        'title': title,
                        'body': body
                    },
                    'sound': sound
                }
            }
            
            if badge is not None:
                message['aps']['badge'] = badge
            
            # Add custom data at root level
            if data:
                for key, value in data.items():
                    if key != 'aps':
                        message[key] = value
            
            # Create notification request
            request = NotificationRequest(
                device_token=device_token,
                message=message
            )
            
            # Send notification (aioapns is async)
            response = await self.client.send_notification(request)
            
            # Check response
            if response.is_successful:
                logger.info(f'Push notification sent successfully to device {device_token[:20]}...')
                return {
                    'success': True,
                    'status': 'sent'
                }
            else:
                status = response.status
                error_msg = f'APNs error: {status}'
                logger.error(f'Failed to send push notification: {error_msg}')
                return {
                    'success': False,
                    'error': error_msg,
                    'status': status
                }
                
        except Exception as e:
            error_msg = f'Error sending push notification: {str(e)}'
            logger.error(error_msg)
            return {
                'success': False,
                'error': error_msg
            }
    
    async def send_notification_batch(
        self,
        notifications: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Send multiple notifications
        Args:
            notifications: List of notification dicts with device_token, title, body, data
        Returns:
            List of results
        """
        results = []
        for notification in notifications:
            result = await self.send_notification(
                device_token=notification['device_token'],
                title=notification['title'],
                body=notification['body'],
                data=notification.get('data'),
                sound=notification.get('sound', 'default'),
                badge=notification.get('badge')
            )
            results.append({
                'device_token': notification['device_token'],
                **result
            })
        return results
    
    async def close(self):
        """Close the APNs client"""
        if self.client:
            await self.client.close()


# Global APNs service instance
_apns_instance: Optional[APNsService] = None


def get_apns_service() -> APNsService:
    """Get the global APNs service instance"""
    global _apns_instance
    if _apns_instance is None:
        _apns_instance = APNsService()
    return _apns_instance
