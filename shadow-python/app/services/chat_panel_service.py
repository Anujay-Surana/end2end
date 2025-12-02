"""
Chat Panel Service

Handles OpenAI chat integration for the chat panel interface with function calling support
"""

import re
import httpx
import os
import json
from datetime import datetime
from typing import List, Dict, Any, Optional, Callable
from app.services.logger import logger


class ChatPanelService:
    def __init__(self, openai_api_key: str):
        self.openai_api_key = openai_api_key
        self.function_handlers: Dict[str, Callable] = {}
    
    def register_function_handler(self, function_name: str, handler: Callable):
        """Register a function handler for tool calling"""
        self.function_handlers[function_name] = handler
    
    def get_tools_definition(self) -> List[Dict[str, Any]]:
        """Get OpenAI tools definition for function calling with improved descriptions"""
        return [
            {
                'type': 'function',
                'function': {
                    'name': 'get_calendar_by_date',
                    'description': (
                        'Retrieve calendar events and meetings for a specific date. '
                        'Use this tool when the user asks about their schedule, calendar, meetings, or events for a particular date. '
                        'Examples: "What meetings do I have today?", "Show me my schedule for tomorrow", "What\'s on my calendar for December 5th?". '
                        'Always use this tool BEFORE generate_meeting_brief if you need to find a meeting first.'
                    ),
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'date': {
                                'type': 'string',
                                'description': (
                                    'Date in YYYY-MM-DD format. Examples: "2024-12-01" for December 1st, 2024. '
                                    'If user says "today", "tomorrow", or "yesterday", convert to actual date using current date context.'
                                ),
                                'pattern': '^\\d{4}-\\d{2}-\\d{2}$'
                            }
                        },
                        'required': ['date']
                    }
                }
            },
            {
                'type': 'function',
                'function': {
                    'name': 'generate_meeting_brief',
                    'description': (
                        'Generate a comprehensive meeting preparation brief for a specific meeting. '
                        'ALWAYS use this tool when the user asks to "prep me", "prepare me", "can you prep me", "get me ready", "prepare for a meeting", "generate a brief", "get meeting prep", or wants details about an upcoming meeting. '
                        'IMPORTANT: Check conversation history first - if there are tool results (role="tool") from get_calendar_by_date, use those meeting objects directly. '
                        'REQUIRED WORKFLOW: If you don\'t have meeting details in conversation history, FIRST call get_calendar_by_date to retrieve meetings, THEN use one of those meeting objects to generate the brief. '
                        'You can provide either meeting_id (if you know it exactly) OR the full meeting object (preferred when available from get_calendar_by_date or conversation history).'
                    ),
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'meeting_id': {
                                'type': 'string',
                                'description': (
                                    'The exact Google Calendar event ID of the meeting. '
                                    'Only use this if you have the exact meeting ID. '
                                    'If you don\'t have the ID, use the meeting object parameter instead.'
                                )
                            },
                            'meeting': {
                                'type': 'object',
                                'description': (
                                    'Complete meeting object from get_calendar_by_date response. '
                                    'This is the PREFERRED method when you have retrieved meetings from get_calendar_by_date. '
                                    'Must include: id (string), summary (string), start (object with dateTime or date), end (object), attendees (array).'
                                ),
                                'properties': {
                                    'id': {
                                        'type': 'string',
                                        'description': 'Google Calendar event ID'
                                    },
                                    'summary': {
                                        'type': 'string',
                                        'description': 'Meeting title/summary'
                                    },
                                    'start': {
                                        'type': 'object',
                                        'description': 'Start time object with dateTime (ISO string) or date (YYYY-MM-DD)'
                                    },
                                    'end': {
                                        'type': 'object',
                                        'description': 'End time object with dateTime (ISO string) or date (YYYY-MM-DD)'
                                    },
                                    'attendees': {
                                        'type': 'array',
                                        'description': 'Array of attendee objects with email and displayName',
                                        'items': {
                                            'type': 'object',
                                            'properties': {
                                                'email': {'type': 'string'},
                                                'displayName': {'type': 'string'}
                                            }
                                        }
                                    }
                                },
                                'required': ['id', 'summary', 'start', 'end']
                            }
                        },
                        'required': []
                    }
                }
            }
        ]

    async def generate_response(
        self,
        message: str,
        conversation_history: List[Dict[str, str]] = None,
        meetings: List[Dict[str, Any]] = None,
        function_results: Optional[Dict[str, Any]] = None,
        tool_call_id: Optional[str] = None,
        user_timezone: str = 'UTC',
        memory_context: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Generate chat response using OpenAI with function calling support
        Args:
            message: User message
            conversation_history: Previous messages in conversation
            meetings: Today's meetings for context
            function_results: Results from previous function calls (for follow-up)
            tool_call_id: The tool_call_id from the original function call
        Returns:
            Dict with 'content' (response text) and optionally 'function_calls' (list of function calls to execute)
        """
        if conversation_history is None:
            conversation_history = []
        if meetings is None:
            meetings = []

        try:
            # Build system prompt with current date/time and memory context
            system_prompt = self.build_system_prompt(meetings, user_timezone, memory_context)

            # Build messages array
            messages = [
                {'role': 'system', 'content': system_prompt},
                *conversation_history,
            ]
            
            # Add function results if provided (from previous function calls)
            # OpenAI expects function results to include the tool_call_id
            if function_results:
                tool_call_id_to_use = tool_call_id or function_results.get('tool_call_id')
                function_name = function_results.get('function_name', 'unknown')
                result_data = function_results.get('result', {})
                
                # Format result as JSON string (OpenAI requirement)
                try:
                    result_content = json.dumps(result_data) if isinstance(result_data, dict) else str(result_data)
                except (TypeError, ValueError) as e:
                    logger.warning(f'Error serializing function result: {str(e)}')
                    result_content = json.dumps({'error': 'Failed to serialize function result'})
                
                function_message = {
                    'role': 'tool',
                    'tool_call_id': tool_call_id_to_use,
                    'name': function_name,
                    'content': result_content
                }
                messages.append(function_message)
            
            # Add user message (only if not already in conversation_history)
            if not function_results:  # Only add user message if this is the first call
                messages.append({'role': 'user', 'content': message})

            # Prepare request - if we're sending function results, don't include tools
            # (model should generate text response based on function results)
            request_data = {
                'model': 'gpt-4o-mini',  # Using gpt-4o-mini for function calling support
                'messages': messages,
                'max_tokens': 500,
                'temperature': 0.7,
            }
            
            # Only include tools if we're not sending function results (first call)
            if not function_results:
                request_data['tools'] = self.get_tools_definition()
                request_data['tool_choice'] = 'auto'

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    'https://api.openai.com/v1/chat/completions',
                    headers={
                        'Content-Type': 'application/json',
                        'Authorization': f'Bearer {self.openai_api_key}'
                    },
                    json=request_data
                )

            if not response.is_success:
                error_data = response.text
                logger.error(f'OpenAI API error: {response.status_code} - {error_data}')
                raise Exception(f'OpenAI API error: {response.status_code}: {error_data}')

            data = response.json()
            
            # Validate response structure
            if 'choices' not in data or len(data['choices']) == 0:
                logger.error(f'Invalid OpenAI API response: no choices', response_data=data)
                raise Exception('Invalid OpenAI API response: no choices')
            
            message_obj = data['choices'][0]['message']
            
            # Check if model wants to call functions
            function_calls = []
            if 'tool_calls' in message_obj and message_obj['tool_calls']:
                for tool_call in message_obj['tool_calls']:
                    try:
                        # Validate tool call structure
                        if 'function' not in tool_call:
                            logger.warning(f'Invalid tool_call structure: missing function', tool_call=tool_call)
                            continue
                        
                        func_name = tool_call['function'].get('name')
                        func_args_str = tool_call['function'].get('arguments', '{}')
                        
                        # Parse arguments JSON
                        try:
                            func_args = json.loads(func_args_str) if isinstance(func_args_str, str) else func_args_str
                        except json.JSONDecodeError as e:
                            logger.warning(f'Failed to parse function arguments: {str(e)}', arguments=func_args_str)
                            func_args = {}
                        
                        function_calls.append({
                            'id': tool_call.get('id', f"call_{len(function_calls)}"),
                            'name': func_name,
                            'arguments': func_args
                        })
                    except Exception as e:
                        logger.error(f'Error processing tool call: {str(e)}', tool_call=tool_call)
                        continue
            
            # Get response content (may be None if only function calls)
            response_text = message_obj.get('content', '').strip() if message_obj.get('content') else None
            
            result = {
                'content': self.strip_markdown(response_text) if response_text else None,
                'function_calls': function_calls if function_calls else None
            }
            
            return result
        except Exception as error:
            logger.error(f'Error generating chat response: {str(error)}')
            raise

    async def generate_initial_update(self, meetings: List[Dict[str, Any]]) -> str:
        """
        Generate initial update about today's meetings
        Args:
            meetings: Today's meetings
        Returns:
            Initial update message
        """
        try:
            if not meetings or len(meetings) == 0:
                return "You have no meetings scheduled for today. I'm here to help whenever you need me!"

            meeting_list = []
            for idx, m in enumerate(meetings):
                start_time = m.get('start', {}).get('dateTime') or m.get('start', {}).get('date') or m.get('start')
                time_str = 'Time TBD'
                
                if start_time:
                    if m.get('start', {}).get('dateTime'):
                        # Timed event - show time
                        try:
                            dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                            time_str = dt.strftime('%I:%M %p')
                        except:
                            time_str = 'Time TBD'
                    elif m.get('start', {}).get('date'):
                        # All-day event - show "All day"
                        time_str = 'All day'
                    elif isinstance(start_time, str):
                        try:
                            dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                            time_str = dt.strftime('%I:%M %p')
                        except:
                            time_str = 'Time TBD'
                
                attendees = ', '.join([a.get('displayName') or a.get('email') for a in (m.get('attendees') or [])])
                meeting_list.append(f"{idx + 1}. {m.get('summary') or 'Untitled Meeting'} at {time_str}{f' with {attendees}' if attendees else ''}")

            async with httpx.AsyncClient() as client:
                response = await client.post(
                    'https://api.openai.com/v1/chat/completions',
                    headers={
                        'Content-Type': 'application/json',
                        'Authorization': f'Bearer {self.openai_api_key}'
                    },
                    json={
                        'model': 'gpt-4.1-mini',
                        'messages': [
                            {
                                'role': 'system',
                                'content': 'You are Shadow, an executive assistant. Provide quick, concise updates about meetings. Keep responses under 100 words.'
                            },
                            {
                                'role': 'user',
                                'content': f"Generate a quick update about today's meetings:\n\n{chr(10).join(meeting_list)}"
                            }
                        ],
                        'max_tokens': 150,
                        'temperature': 0.7
                    }
                )

            if not response.is_success:
                raise Exception(f'OpenAI API error: {response.status_code}')

            data = response.json()
            response_text = data['choices'][0]['message']['content'].strip()
            # Strip markdown formatting for clean display
            return self.strip_markdown(response_text)
        except Exception as error:
            logger.error(f'Error generating initial update: {str(error)}')
            # Fallback message
            return f"You have {len(meetings)} meeting{'s' if len(meetings) != 1 else ''} scheduled for today. Ready to help you prepare!"

    def strip_markdown(self, text: str) -> str:
        """
        Strip markdown formatting from text
        Args:
            text: Text with markdown
        Returns:
            Clean text without markdown
        """
        if not text:
            return text
        # Remove markdown formatting: **bold**, *italic*, `code`, etc.
        return re.sub(r'\*\*([^*]+)\*\*', r'\1', text).replace('*', '').replace('`', '').replace(r'#{1,6}\s+', '').replace(r'\[([^\]]+)\]\([^\)]+\)', r'\1').strip()

    def build_system_prompt(self, meetings: List[Dict[str, Any]] = None, user_timezone: str = 'UTC', memory_context: Optional[str] = None) -> str:
        """
        Build system prompt with meeting context and current date/time
        Args:
            meetings: Today's meetings
            user_timezone: User's timezone (e.g., 'America/New_York', 'UTC')
        Returns:
            System prompt
        """
        # Get current date/time in user's timezone
        from datetime import datetime
        import pytz
        try:
            user_tz = pytz.timezone(user_timezone)
        except:
            user_tz = pytz.UTC
        
        now_utc = datetime.now(pytz.UTC)
        now_user_tz = now_utc.astimezone(user_tz)
        current_date = now_user_tz.strftime('%Y-%m-%d')
        current_time = now_user_tz.strftime('%I:%M %p %Z')
        current_day = now_user_tz.strftime('%A')
        
        prompt = f"""You are Shadow, an executive assistant AI that helps users prepare for meetings and manage their day.

CURRENT DATE AND TIME (User's timezone: {user_timezone}):
- Today is {current_day}, {current_date}
- Current time: {current_time}
- When users say "today", "tomorrow", "yesterday", convert these to actual dates using the current date context above.

YOUR CAPABILITIES AND TOOL USAGE:

1. **get_calendar_by_date** - Use this tool to retrieve calendar events for any date.
   - ALWAYS use this when user asks about their schedule, calendar, meetings, or events
   - Examples: "What meetings do I have today?" → call get_calendar_by_date with today's date
   - Examples: "Show me tomorrow's schedule" → call get_calendar_by_date with tomorrow's date
   - Convert relative dates ("today", "tomorrow") to YYYY-MM-DD format using current date context

2. **generate_meeting_brief** - Use this tool to generate meeting preparation briefs.
   - ALWAYS use when user asks to "prep me", "prepare me", "can you prep me", "get me ready", "prepare for a meeting", "generate a brief", "get meeting prep", or wants details about a meeting
   - Examples: "prep me for it", "can you prep me", "prepare me for my meeting", "get me ready for the meeting"
   - IMPORTANT: Function results from previous calls (like get_calendar_by_date) are available in the conversation history. If you see a tool result with meeting data, use that meeting object directly.
   - WORKFLOW: If you don't have complete meeting details in conversation history, FIRST call get_calendar_by_date, THEN use one of the returned meeting objects
   - Prefer passing the full meeting object (from get_calendar_by_date or conversation history) over just meeting_id when possible

TOOL USAGE RULES:
- ALWAYS use tools when appropriate - don't guess or make assumptions about calendar data
- Check conversation history FIRST - previous tool results (role='tool') contain function outputs that you can use
- If user asks about meetings but you don't have the data in conversation history, use get_calendar_by_date first
- If user wants meeting prep (says "prep me", "prepare me", etc.) but you don't have meeting details in conversation history, get calendar first, then generate brief
- When multiple tools are needed, call them in sequence (get_calendar_by_date → generate_meeting_brief)
- After calling tools, provide a clear, helpful response based on the tool results
- Remember: Tool results from previous messages are in the conversation - you can reference them directly

RESPONSE STYLE:
- Be concise, friendly, and professional
- Keep responses under 100 words unless user asks for more detail
- After tool calls, summarize the results clearly
- If tool calls fail, explain what went wrong and suggest alternatives"""
        
        # Add memory context if available
        if memory_context:
            prompt += f"\n\n{memory_context}"

        if meetings and len(meetings) > 0:
            prompt += "\n\nToday's meetings:\n"
            for idx, m in enumerate(meetings):
                start_time = m.get('start', {}).get('dateTime') or m.get('start', {}).get('date') or m.get('start')
                time_str = 'Time TBD'
                
                if start_time:
                    if m.get('start', {}).get('dateTime'):
                        try:
                            dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                            time_str = dt.strftime('%I:%M %p')
                        except:
                            time_str = 'Time TBD'
                    elif m.get('start', {}).get('date'):
                        time_str = 'All day'
                    elif isinstance(start_time, str):
                        try:
                            dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                            time_str = dt.strftime('%I:%M %p')
                        except:
                            time_str = 'Time TBD'
                
                attendees = ', '.join([a.get('displayName') or a.get('email') for a in (m.get('attendees') or [])]) or 'No attendees'
                prompt += f"{idx + 1}. {m.get('summary') or 'Untitled Meeting'} at {time_str} with {attendees}\n"

        return prompt

