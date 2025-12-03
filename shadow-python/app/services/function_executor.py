"""
Function Executor Service

Handles execution of tool/function calls with proper validation, error handling, and logging
"""

from typing import Dict, Any, Optional, List
from datetime import datetime, timezone, timedelta
from app.services.logger import logger
from app.services.google_api import fetch_calendar_events
from app.db.queries.accounts import get_accounts_by_user_id
from app.services.token_refresh import ensure_all_tokens_valid
from app.routes.meetings import MeetingPrepRequest, _generate_prep_response
from app.db.queries.meeting_briefs import create_meeting_brief
import json
import pytz


class FunctionExecutor:
    """Service for executing function calls with proper validation and error handling"""
    
    def __init__(self, user_id: str, user: Optional[Dict[str, Any]] = None, user_timezone: str = 'UTC'):
        self.user_id = user_id
        self.user = user
        self.user_timezone = user_timezone
        
        # Get timezone object
        try:
            self.tz = pytz.timezone(user_timezone)
            logger.info(f'FunctionExecutor initialized with timezone: {user_timezone}', userId=user_id)
        except Exception as e:
            logger.warning(f'Invalid timezone {user_timezone}, using UTC: {str(e)}', userId=user_id)
            self.tz = pytz.UTC
            self.user_timezone = 'UTC'
    
    async def execute(self, function_name: str, arguments: Dict[str, Any], tool_call_id: str) -> Dict[str, Any]:
        """
        Execute a function call
        
        Args:
            function_name: Name of the function to execute
            arguments: Function arguments
            tool_call_id: OpenAI tool call ID
            
        Returns:
            Dict with function_name, tool_call_id, and result
        """
        if function_name == 'get_calendar_by_date':
            return await self._get_calendar_by_date(arguments, tool_call_id)
        elif function_name == 'generate_meeting_brief':
            return await self._generate_meeting_brief(arguments, tool_call_id)
        else:
            logger.warning(f'Unknown function: {function_name}', userId=self.user_id)
            return {
                'function_name': function_name,
                'tool_call_id': tool_call_id,
                'result': {'error': f'Unknown function: {function_name}'}
            }
    
    async def _get_calendar_by_date(self, arguments: Dict[str, Any], tool_call_id: str) -> Dict[str, Any]:
        """
        Get calendar events for a specific date
        
        Args:
            arguments: Must contain 'date' in YYYY-MM-DD format
            tool_call_id: Tool call ID
            
        Returns:
            Function result dict
        """
        # Validate required parameter
        date = arguments.get('date')
        if not date:
            return {
                'function_name': 'get_calendar_by_date',
                'tool_call_id': tool_call_id,
                'result': {'error': 'Missing required parameter: date'}
            }
        
        # Validate date format
        try:
            parsed_date = datetime.strptime(date, '%Y-%m-%d')
        except ValueError:
            return {
                'function_name': 'get_calendar_by_date',
                'tool_call_id': tool_call_id,
                'result': {'error': f'Invalid date format: {date}. Expected YYYY-MM-DD format.'}
            }
        
        try:
            # Convert to UTC datetime range
            selected_date = parsed_date.replace(tzinfo=timezone.utc)
            start_of_day = selected_date.replace(hour=0, minute=0, second=0, microsecond=0)
            end_of_day = selected_date.replace(hour=23, minute=59, second=59, microsecond=999999)
            
            # Get user accounts
            accounts = await get_accounts_by_user_id(self.user_id)
            if not accounts:
                return {
                    'function_name': 'get_calendar_by_date',
                    'tool_call_id': tool_call_id,
                    'result': {'error': 'No calendar accounts found. Please connect a Google account.'}
                }
            
            # Refresh tokens
            await ensure_all_tokens_valid(accounts)
            valid_accounts = [acc for acc in accounts if acc.get('access_token')]
            
            if not valid_accounts:
                return {
                    'function_name': 'get_calendar_by_date',
                    'tool_call_id': tool_call_id,
                    'result': {'error': 'No valid calendar accounts. Please reconnect your Google account.'}
                }
            
            # Fetch meetings from all accounts
            all_meetings = []
            errors = []
            for account in valid_accounts:
                try:
                    events = await fetch_calendar_events(
                        account,
                        start_of_day.isoformat(),
                        end_of_day.isoformat(),
                        100
                    )
                    all_meetings.extend(events)
                except Exception as e:
                    error_msg = f'Error fetching calendar from account {account.get("email", "unknown")}: {str(e)}'
                    logger.error(error_msg, userId=self.user_id)
                    errors.append(error_msg)
            
            # Extract and update timezone from calendar events
            if all_meetings:
                try:
                    from app.db.queries.users import extract_and_update_timezone_from_calendar
                    await extract_and_update_timezone_from_calendar(self.user_id, all_meetings)
                except Exception as e:
                    logger.warning(f'Failed to extract timezone from calendar: {str(e)}', userId=self.user_id)
            
            # Format meetings for response with timezone conversion
            formatted_meetings = []
            for m in all_meetings[:20]:  # Limit to 20 meetings
                try:
                    # Handle start time - convert to user's timezone
                    start_obj = m.get('start', {})
                    start_iso = None
                    start_formatted = ''
                    
                    if isinstance(start_obj, str):
                        start_iso = start_obj
                    elif isinstance(start_obj, dict):
                        start_iso = start_obj.get('dateTime') or start_obj.get('date', '')
                    
                    # Convert to user's timezone if we have a datetime
                    if start_iso and 'T' in start_iso:
                        try:
                            # Parse UTC datetime
                            dt_utc = datetime.fromisoformat(start_iso.replace('Z', '+00:00'))
                            if dt_utc.tzinfo is None:
                                dt_utc = dt_utc.replace(tzinfo=pytz.UTC)
                            
                            # Convert to user's timezone
                            dt_user = dt_utc.astimezone(self.tz)
                            start_formatted = dt_user.strftime('%I:%M %p %Z')
                            logger.debug(
                                f'Converted meeting time',
                                userId=self.user_id,
                                meeting_id=m.get('id'),
                                utc_time=start_iso,
                                user_timezone=self.user_timezone,
                                converted_time=start_formatted
                            )
                        except Exception as e:
                            logger.warning(f'Error converting start time: {str(e)}', meeting_id=m.get('id'))
                            start_formatted = start_iso
                    elif start_iso:
                        # All-day event
                        start_formatted = start_iso
                    
                    # Handle end time - convert to user's timezone
                    end_obj = m.get('end', {})
                    end_iso = None
                    end_formatted = ''
                    
                    if isinstance(end_obj, str):
                        end_iso = end_obj
                    elif isinstance(end_obj, dict):
                        end_iso = end_obj.get('dateTime') or end_obj.get('date', '')
                    
                    if end_iso and 'T' in end_iso:
                        try:
                            dt_utc = datetime.fromisoformat(end_iso.replace('Z', '+00:00'))
                            if dt_utc.tzinfo is None:
                                dt_utc = dt_utc.replace(tzinfo=pytz.UTC)
                            dt_user = dt_utc.astimezone(self.tz)
                            end_formatted = dt_user.strftime('%I:%M %p %Z')
                        except Exception as e:
                            logger.warning(f'Error converting end time: {str(e)}', meeting_id=m.get('id'))
                            end_formatted = end_iso
                    elif end_iso:
                        end_formatted = end_iso
                    
                    # Handle attendees - ensure they're dicts
                    attendees_list = m.get('attendees', [])
                    attendee_emails = []
                    for a in attendees_list:
                        if isinstance(a, dict):
                            email = a.get('email', '')
                            if email:
                                attendee_emails.append(email)
                        elif isinstance(a, str):
                            attendee_emails.append(a)
                    
                    formatted_meetings.append({
                        'id': m.get('id'),
                        'summary': m.get('summary', 'Untitled'),
                        'start': start_formatted or start_iso or '',
                        'start_iso': start_iso,  # Keep original for reference
                        'end': end_formatted or end_iso or '',
                        'end_iso': end_iso,  # Keep original for reference
                        'timezone': self.user_timezone,  # Include timezone info
                        'attendees': attendee_emails
                    })
                except Exception as e:
                    logger.warning(f'Error formatting meeting: {str(e)}', meeting_id=m.get('id'))
                    continue
            
            result = {
                'date': date,
                'meetings': formatted_meetings,
                'count': len(formatted_meetings)
            }
            
            if errors:
                result['warnings'] = errors
            
            logger.info(f'Retrieved {len(formatted_meetings)} meetings for {date}', userId=self.user_id)
            
            return {
                'function_name': 'get_calendar_by_date',
                'tool_call_id': tool_call_id,
                'result': result
            }
            
        except Exception as e:
            logger.error(f'Error in get_calendar_by_date: {str(e)}', userId=self.user_id)
            return {
                'function_name': 'get_calendar_by_date',
                'tool_call_id': tool_call_id,
                'result': {'error': f'Failed to retrieve calendar: {str(e)}'}
            }
    
    async def _generate_meeting_brief(self, arguments: Dict[str, Any], tool_call_id: str) -> Dict[str, Any]:
        """
        Generate a meeting brief
        
        Args:
            arguments: Must contain either 'meeting_id' (string) or 'meeting' (object)
            tool_call_id: Tool call ID
            
        Returns:
            Function result dict
        """
        meeting_id = arguments.get('meeting_id')
        meeting_obj = arguments.get('meeting')
        
        # Validate input
        if not meeting_id and not meeting_obj:
            return {
                'function_name': 'generate_meeting_brief',
                'tool_call_id': tool_call_id,
                'result': {'error': 'Either meeting_id or meeting object is required'}
            }
        
        # If only meeting_id provided, fetch meeting from calendar
        if not meeting_obj and meeting_id:
            try:
                meeting_obj = await self._fetch_meeting_by_id(meeting_id)
                if not meeting_obj:
                    return {
                        'function_name': 'generate_meeting_brief',
                        'tool_call_id': tool_call_id,
                        'result': {'error': f'Meeting with ID {meeting_id} not found in calendar'}
                    }
            except Exception as e:
                logger.error(f'Error fetching meeting by ID: {str(e)}', userId=self.user_id)
                return {
                    'function_name': 'generate_meeting_brief',
                    'tool_call_id': tool_call_id,
                    'result': {'error': f'Error fetching meeting: {str(e)}'}
                }
        
        # Validate meeting object structure
        if not isinstance(meeting_obj, dict):
            return {
                'function_name': 'generate_meeting_brief',
                'tool_call_id': tool_call_id,
                'result': {'error': 'Invalid meeting object format'}
            }
        
        # Extract meeting ID
        final_meeting_id = meeting_obj.get('id') or meeting_id
        if not final_meeting_id:
            return {
                'function_name': 'generate_meeting_brief',
                'tool_call_id': tool_call_id,
                'result': {'error': 'Meeting ID is required but not found in meeting object'}
            }
        
        # Generate brief
        try:
            # Extract attendees
            attendees = meeting_obj.get('attendees', [])
            if not isinstance(attendees, list):
                attendees = []
            
            # Create prep request
            prep_request = MeetingPrepRequest(
                meeting=meeting_obj,
                attendees=attendees
            )
            
            # Generate brief (read streaming response)
            brief_data = None
            async for chunk in _generate_prep_response(prep_request, self.user, None, f'chat-{tool_call_id}'):
                try:
                    chunk_data = json.loads(chunk)
                    if chunk_data.get('type') == 'complete':
                        brief_data = {k: v for k, v in chunk_data.items() if k != 'type'}
                        break
                except (json.JSONDecodeError, KeyError):
                    continue
            
            if not brief_data:
                return {
                    'function_name': 'generate_meeting_brief',
                    'tool_call_id': tool_call_id,
                    'result': {'error': 'Failed to generate brief - no data received'},
                    'meeting': meeting_obj
                }
            
            # Store brief in database
            try:
                await create_meeting_brief(self.user_id, final_meeting_id, brief_data)
            except Exception as e:
                logger.warning(f'Failed to store brief in database: {str(e)}', userId=self.user_id)
                # Continue anyway - brief was generated
            
            logger.info(f'Generated brief for meeting {final_meeting_id}', userId=self.user_id)
            
            return {
                'function_name': 'generate_meeting_brief',
                'tool_call_id': tool_call_id,
                'result': {
                    'meeting_id': final_meeting_id,
                    'status': 'completed',
                    'summary': brief_data.get('summary', 'Brief generated successfully'),
                    'message': 'Brief generated successfully. The brief will be displayed in a modal.'
                },
                'meeting': meeting_obj,
                'brief': brief_data
            }
            
        except Exception as e:
            logger.error(f'Error generating brief: {str(e)}', userId=self.user_id)
            return {
                'function_name': 'generate_meeting_brief',
                'tool_call_id': tool_call_id,
                'result': {'error': f'Error generating brief: {str(e)}'},
                'meeting': meeting_obj
            }
    
    async def _fetch_meeting_by_id(self, meeting_id: str) -> Optional[Dict[str, Any]]:
        """
        Fetch a meeting from calendar by ID
        
        Args:
            meeting_id: Google Calendar event ID
            
        Returns:
            Meeting object or None if not found
        """
        try:
            # Get user accounts
            accounts = await get_accounts_by_user_id(self.user_id)
            await ensure_all_tokens_valid(accounts)
            valid_accounts = [acc for acc in accounts if acc.get('access_token')]
            
            if not valid_accounts:
                return None
            
            # Search for meeting in next 30 days
            now_utc = datetime.now(timezone.utc)
            search_end = now_utc + timedelta(days=30)
            
            # Search across all accounts
            for account in valid_accounts:
                try:
                    events = await fetch_calendar_events(
                        account,
                        now_utc.isoformat(),
                        search_end.isoformat(),
                        100
                    )
                    for event in events:
                        if event.get('id') == meeting_id:
                            return event
                except Exception as e:
                    logger.warning(f'Error searching account {account.get("email")}: {str(e)}', userId=self.user_id)
                    continue
            
            return None
            
        except Exception as e:
            logger.error(f'Error in _fetch_meeting_by_id: {str(e)}', userId=self.user_id)
            return None

