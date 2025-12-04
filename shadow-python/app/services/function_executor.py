"""
Function Executor Service

Handles execution of tool/function calls with proper validation, error handling, and logging
"""

from typing import Dict, Any, Optional, List, Tuple
from datetime import datetime, timezone, timedelta
from app.services.logger import logger
from app.services.google_api import fetch_calendar_events
from app.db.queries.accounts import get_accounts_by_user_id
from app.services.token_refresh import ensure_all_tokens_valid
from app.routes.meetings import MeetingPrepRequest, _generate_prep_response
from app.db.queries.meeting_briefs import create_meeting_brief
from app.services.parallel_client import get_parallel_client
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
    
    def _resolve_timezone(self, override_tz: Optional[str]) -> Tuple[str, pytz.BaseTzInfo]:
        """
        Resolve timezone from override or defaults with safe fallback to UTC.
        Returns (tz_label, tz_obj)
        """
        tz_label = override_tz or self.user_timezone or 'UTC'
        try:
            tz_obj = pytz.timezone(tz_label)
        except Exception as e:
            logger.warning(f'Invalid timezone {tz_label}, using UTC: {str(e)}', userId=self.user_id)
            tz_label = 'UTC'
            tz_obj = pytz.UTC
        return tz_label, tz_obj

    def _format_meetings(self, meetings: List[Dict[str, Any]], tz_obj: pytz.BaseTzInfo, tz_label: str) -> List[Dict[str, Any]]:
        """
        Format meetings while preserving raw Google structure and adding helpful fields.
        """
        formatted_meetings = []
        for idx, m in enumerate(meetings):
            try:
                meeting = {**m}

                start_obj = m.get('start', {})
                start_iso = None
                start_formatted = ''

                if isinstance(start_obj, str):
                    start_iso = start_obj
                elif isinstance(start_obj, dict):
                    start_iso = start_obj.get('dateTime') or start_obj.get('date', '')

                if start_iso and 'T' in start_iso:
                    try:
                        dt_utc = datetime.fromisoformat(start_iso.replace('Z', '+00:00'))
                        if dt_utc.tzinfo is None:
                            dt_utc = dt_utc.replace(tzinfo=pytz.UTC)
                        dt_user = dt_utc.astimezone(tz_obj)
                        start_formatted = dt_user.strftime('%I:%M %p %Z')
                    except Exception as e:
                        logger.warning(f'Error converting start time: {str(e)}', meeting_id=m.get('id'))
                        start_formatted = start_iso
                elif start_iso:
                    start_formatted = start_iso  # All-day event

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
                        dt_user = dt_utc.astimezone(tz_obj)
                        end_formatted = dt_user.strftime('%I:%M %p %Z')
                    except Exception as e:
                        logger.warning(f'Error converting end time: {str(e)}', meeting_id=m.get('id'))
                        end_formatted = end_iso
                elif end_iso:
                    end_formatted = end_iso

                meeting['_index'] = idx + 1  # 1-based index for ordering
                meeting['start_formatted'] = start_formatted
                meeting['end_formatted'] = end_formatted
                meeting['_timezone'] = tz_label

                if not meeting.get('summary'):
                    meeting['summary'] = 'Untitled Meeting'

                formatted_meetings.append(meeting)
            except Exception as e:
                logger.warning(f'Error formatting meeting: {str(e)}', meeting_id=m.get('id'))
                continue

        return formatted_meetings

    async def _collect_meetings(self, start_iso: str, end_iso: str, limit: int) -> (List[Dict[str, Any]], List[str]):
        """
        Fetch meetings across all valid calendar accounts for a window.
        Returns (meetings, warnings)
        """
        accounts = await get_accounts_by_user_id(self.user_id)
        if not accounts:
            return [], ['No calendar accounts found. Please connect a Google account.']

        await ensure_all_tokens_valid(accounts)
        valid_accounts = [acc for acc in accounts if acc.get('access_token')]

        if not valid_accounts:
            return [], ['No valid calendar accounts. Please reconnect your Google account.']

        all_meetings: List[Dict[str, Any]] = []
        errors: List[str] = []

        for account in valid_accounts:
            try:
                events = await fetch_calendar_events(
                    account,
                    start_iso,
                    end_iso,
                    limit
                )
                all_meetings.extend(events)
            except Exception as e:
                error_msg = f'Error fetching calendar from account {account.get("email", "unknown")}: {str(e)}'
                logger.error(error_msg, userId=self.user_id)
                errors.append(error_msg)

        # Extract and update timezone from calendar events when present
        if all_meetings:
            try:
                from app.db.queries.users import extract_and_update_timezone_from_calendar
                await extract_and_update_timezone_from_calendar(self.user_id, all_meetings)
            except Exception as e:
                logger.warning(f'Failed to extract timezone from calendar: {str(e)}', userId=self.user_id)

        return all_meetings, errors

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
        elif function_name == 'list_calendar_events':
            return await self._list_calendar_events(arguments, tool_call_id)
        elif function_name == 'get_calendar_event':
            return await self._get_calendar_event(arguments, tool_call_id)
        elif function_name == 'generate_meeting_brief':
            return await self._generate_meeting_brief(arguments, tool_call_id)
        elif function_name == 'parallel_search':
            return await self._parallel_search(arguments, tool_call_id)
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

        tz_label, tz_obj = self._resolve_timezone(arguments.get('timezone'))

        try:
            # Convert to UTC datetime range using timezone-aware date
            selected_date = tz_obj.localize(parsed_date)
            start_of_day = selected_date.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
            end_of_day = selected_date.replace(hour=23, minute=59, second=59, microsecond=999999).astimezone(timezone.utc)

            all_meetings, errors = await self._collect_meetings(
                start_of_day.isoformat(),
                end_of_day.isoformat(),
                100
            )

            formatted_meetings = self._format_meetings(all_meetings[:20], tz_obj, tz_label)

            result = {
                'date': date,
                'timezone': tz_label,
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

    async def _list_calendar_events(self, arguments: Dict[str, Any], tool_call_id: str) -> Dict[str, Any]:
        """
        List calendar events within a date/time window.
        Supports start/end ISO strings or a single date (local to timezone).
        """
        tz_label, tz_obj = self._resolve_timezone(arguments.get('timezone'))
        start_iso_arg = arguments.get('start_iso')
        end_iso_arg = arguments.get('end_iso')
        date_arg = arguments.get('date')
        limit = arguments.get('limit', 20)

        try:
            limit_int = int(limit)
            limit_int = max(1, min(limit_int, 100))
        except Exception:
            limit_int = 20

        def _parse_iso(dt_str: str) -> datetime:
            cleaned = dt_str.replace('Z', '+00:00')
            dt = datetime.fromisoformat(cleaned)
            if dt.tzinfo is None:
                dt = tz_obj.localize(dt)
            return dt.astimezone(timezone.utc)

        try:
            start_dt = _parse_iso(start_iso_arg) if start_iso_arg else None
            end_dt = _parse_iso(end_iso_arg) if end_iso_arg else None
        except Exception as e:
            return {
                'function_name': 'list_calendar_events',
                'tool_call_id': tool_call_id,
                'result': {'error': f'Invalid datetime format: {str(e)}'}
            }

        if date_arg and not start_dt:
            try:
                parsed_date = datetime.strptime(date_arg, '%Y-%m-%d')
                start_dt = tz_obj.localize(parsed_date).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
            except Exception as e:
                return {
                    'function_name': 'list_calendar_events',
                    'tool_call_id': tool_call_id,
                    'result': {'error': f'Invalid date format: {str(e)}'}
                }

        if not start_dt:
            # Default to "today" in user's timezone if nothing provided
            now_tz = datetime.now(tz_obj)
            start_dt = now_tz.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)

        if not end_dt:
            end_dt = (start_dt + timedelta(days=1))

        try:
            all_meetings, errors = await self._collect_meetings(
                start_dt.isoformat(),
                end_dt.isoformat(),
                limit_int
            )

            formatted_meetings = self._format_meetings(all_meetings[:limit_int], tz_obj, tz_label)

            result = {
                'start_iso': start_dt.isoformat(),
                'end_iso': end_dt.isoformat(),
                'timezone': tz_label,
                'meetings': formatted_meetings,
                'count': len(formatted_meetings)
            }

            if errors:
                result['warnings'] = errors

            logger.info(
                f'Retrieved {len(formatted_meetings)} meetings between {start_dt.isoformat()} and {end_dt.isoformat()}',
                userId=self.user_id
            )

            return {
                'function_name': 'list_calendar_events',
                'tool_call_id': tool_call_id,
                'result': result
            }
        except Exception as e:
            logger.error(f'Error in list_calendar_events: {str(e)}', userId=self.user_id)
            return {
                'function_name': 'list_calendar_events',
                'tool_call_id': tool_call_id,
                'result': {'error': f'Failed to list calendar events: {str(e)}'}
            }

    async def _get_calendar_event(self, arguments: Dict[str, Any], tool_call_id: str) -> Dict[str, Any]:
        """
        Fetch a single calendar event by ID across connected accounts.
        """
        event_id = arguments.get('event_id') or arguments.get('id')
        tz_label, tz_obj = self._resolve_timezone(arguments.get('timezone'))

        if not event_id:
            return {
                'function_name': 'get_calendar_event',
                'tool_call_id': tool_call_id,
                'result': {'error': 'Missing required parameter: event_id'}
            }

        try:
            meeting_obj = await self._fetch_meeting_by_id(event_id)
            if not meeting_obj:
                return {
                    'function_name': 'get_calendar_event',
                    'tool_call_id': tool_call_id,
                    'result': {'error': f'Meeting with ID {event_id} not found in calendar'}
                }

            formatted = self._format_meetings([meeting_obj], tz_obj, tz_label)
            meeting_formatted = formatted[0] if formatted else meeting_obj

            return {
                'function_name': 'get_calendar_event',
                'tool_call_id': tool_call_id,
                'result': {
                    'event_id': event_id,
                    'timezone': tz_label,
                    'meeting': meeting_formatted
                }
            }
        except Exception as e:
            logger.error(f'Error in get_calendar_event: {str(e)}', userId=self.user_id)
            return {
                'function_name': 'get_calendar_event',
                'tool_call_id': tool_call_id,
                'result': {'error': f'Failed to retrieve event: {str(e)}'}
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

    async def _parallel_search(self, arguments: Dict[str, Any], tool_call_id: str) -> Dict[str, Any]:
        """
        Perform a Parallel AI search for web/info retrieval.
        """
        objective = arguments.get('objective') or arguments.get('description')
        search_queries = arguments.get('search_queries') or arguments.get('queries') or []
        max_results = arguments.get('max_results', 8)
        max_chars_per_result = arguments.get('max_chars_per_result', 2500)
        processor = arguments.get('processor', 'base')

        if not objective or not search_queries:
            return {
                'function_name': 'parallel_search',
                'tool_call_id': tool_call_id,
                'result': {'error': 'objective and search_queries are required'}
            }

        client = get_parallel_client()
        if not client or not client.is_available():
            return {
                'function_name': 'parallel_search',
                'tool_call_id': tool_call_id,
                'result': {'error': 'Parallel API key not configured; search unavailable'}
            }

        try:
            response = await client.beta.search(
                objective=objective,
                search_queries=search_queries,
                max_results=max_results,
                max_chars_per_result=max_chars_per_result,
                processor=processor
            )

            results = response.get('results', [])
            return {
                'function_name': 'parallel_search',
                'tool_call_id': tool_call_id,
                'result': {
                    'objective': objective,
                    'results': results,
                    'search_id': response.get('search_id'),
                    'result_count': len(results)
                }
            }
        except Exception as e:
            logger.error(f'Parallel search error: {str(e)}', userId=self.user_id)
            return {
                'function_name': 'parallel_search',
                'tool_call_id': tool_call_id,
                'result': {'error': f'Parallel search failed: {str(e)}'}
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

