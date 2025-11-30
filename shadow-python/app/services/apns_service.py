"""
APNs Service

Handles sending push notifications to iOS devices via Apple Push Notification service
"""

import os
import json
import sys
from typing import Dict, List, Any, Optional
from app.services.logger import logger

# compat-fork-apns2 should handle Python 3.12 compatibility, but keep this as fallback
if sys.version_info >= (3, 9):
    import collections.abc
    import collections
    # Add all missing collections classes for compatibility (if needed)
    for name in ['Iterable', 'Mapping', 'MutableSet', 'MutableMapping', 'Callable', 'Sequence']:
        if not hasattr(collections, name):
            setattr(collections, name, getattr(collections.abc, name))

# Try to import compat-fork-apns2 (compatible with PyJWT 2.9+)
# This is a drop-in replacement for apns2 with better dependency compatibility
try:
    from apns2.client import APNsClient
    from apns2.payload import Payload
    from apns2.credentials import TokenCredentials
    APNS_AVAILABLE = True
except ImportError as e:
    logger.warning(f'APNs library (compat-fork-apns2) not available: {str(e)}. Push notifications will be disabled.')
    APNsClient = None
    Payload = None
    TokenCredentials = None
    APNS_AVAILABLE = False
except Exception as e:
    # Handle any other compatibility issues
    logger.warning(f'APNs library has compatibility issues: {str(e)}. Push notifications will be disabled.')
    APNsClient = None
    Payload = None
    TokenCredentials = None
    APNS_AVAILABLE = False


class APNsService:
    def __init__(self):
        self.client: Optional[APNsClient] = None
        self.credentials: Optional[TokenCredentials] = None
        self._initialize()
    
    def _initialize(self):
        """Initialize APNs client with credentials"""
        if not APNS_AVAILABLE:
            logger.warn('APNs2 library not available - push notifications disabled')
            return
            
        try:
            key_id = os.getenv('APNS_KEY_ID')
            team_id = os.getenv('APNS_TEAM_ID')
            bundle_id = os.getenv('APNS_BUNDLE_ID', 'com.kordn8.shadow')
            use_sandbox = os.getenv('APNS_USE_SANDBOX', 'true').lower() == 'true'
            
            # Get key content (either from file or environment variable)
            key_path = os.getenv('APNS_KEY_PATH')
            key_content = os.getenv('APNS_KEY_CONTENT')
            
            if not key_id or not team_id:
                logger.warn('APNs credentials not configured (APNS_KEY_ID, APNS_TEAM_ID)')
                return
            
            if not key_path and not key_content:
                logger.warn('APNs key not configured (APNS_KEY_PATH or APNS_KEY_CONTENT)')
                return
            
            # Determine key path - use file path or create temp file from content
            actual_key_path = None
            if key_path and os.path.exists(key_path):
                actual_key_path = key_path
            elif key_content:
                # Create temporary file from key content
                import tempfile
                temp_file = tempfile.NamedTemporaryFile(mode='w', suffix='.p8', delete=False)
                temp_file.write(key_content)
                temp_file.close()
                actual_key_path = temp_file.name
            else:
                logger.warn('APNs key not found (neither APNS_KEY_PATH nor APNS_KEY_CONTENT provided)')
                return
            
            # Create credentials - PyAPNs2 requires file path
            self.credentials = TokenCredentials(
                auth_key_path=actual_key_path,
                auth_key_id=key_id,
                team_id=team_id
            )
            
            # Create client
            topic = bundle_id
            use_sandbox = use_sandbox
            self.client = APNsClient(
                credentials=self.credentials,
                use_sandbox=use_sandbox,
                use_alternative_port=False
            )
            
            logger.info(f'APNs service initialized (sandbox: {use_sandbox}, bundle: {bundle_id})')
            
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
            payload_data = {
                'aps': {
                    'alert': {
                        'title': title,
                        'body': body
                    },
                    'sound': sound
                }
            }
            
            if badge is not None:
                payload_data['aps']['badge'] = badge
            
            # Add custom data
            if data:
                # Merge custom data at root level (not under 'aps')
                for key, value in data.items():
                    if key != 'aps':
                        payload_data[key] = value
            
            # Build payload - PyAPNs2 Payload expects dict format
            payload_dict = {
                'aps': payload_data['aps']
            }
            
            # Add custom data at root level
            if data:
                for key, value in data.items():
                    if key != 'aps':
                        payload_dict[key] = value
            
            payload = Payload(**payload_dict)
            
            # Send notification (PyAPNs2 is synchronous, run in thread pool)
            import asyncio
            topic = os.getenv('APNS_BUNDLE_ID', 'com.kordn8.shadow')
            
            # Run synchronous APNs call in executor
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.client.send_notification(
                    device_token,
                    payload,
                    topic=topic
                )
            )
            
            # PyAPNs2 send_notification returns a response object
            if hasattr(response, 'is_successful') and response.is_successful:
                logger.info(f'Push notification sent successfully to device {device_token[:20]}...')
                return {
                    'success': True,
                    'status': 'sent'
                }
            else:
                status = getattr(response, 'status', 'unknown')
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


# Global APNs service instance
_apns_instance: Optional[APNsService] = None


def get_apns_service() -> APNsService:
    """Get the global APNs service instance"""
    global _apns_instance
    if _apns_instance is None:
        _apns_instance = APNsService()
    return _apns_instance

