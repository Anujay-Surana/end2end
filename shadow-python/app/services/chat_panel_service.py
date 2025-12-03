"""
Chat Panel Service

Handles OpenAI chat integration for the chat panel interface with function calling support
"""

import re
import httpx
import os
import json
from datetime import datetime, timedelta
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
        """Get OpenAI tools definition for function calling"""
        return [
            {
                'type': 'function',
                'function': {
                    'name': 'get_calendar_by_date',
                    'description': 'Retrieve calendar events for a specific date. Use when user asks about schedule, calendar, or meetings.',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'date': {
                                'type': 'string',
                                'description': 'Date in YYYY-MM-DD format. Convert relative dates (today, tomorrow) using system prompt context.',
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
                    'description': 'Generate meeting preparation brief. Use when user says "prep me", "prepare me", or wants meeting details. Prefer passing full meeting object from get_calendar_by_date.',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'meeting_id': {
                                'type': 'string',
                                'description': 'Google Calendar event ID'
                            },
                            'meeting': {
                                'type': 'object',
                                'description': 'Complete meeting object from get_calendar_by_date response',
                                'properties': {
                                    'id': {'type': 'string'},
                                    'summary': {'type': 'string'},
                                    'start': {'type': 'object'},
                                    'end': {'type': 'object'},
                                    'attendees': {
                                        'type': 'array',
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
        user_timezone: str = 'UTC',
        memory_context: Optional[str] = None,
        is_continuation: bool = False
    ) -> Dict[str, Any]:
        """
        Generate chat response using OpenAI with function calling support
        
        Args:
            message: User message
            conversation_history: Previous messages in OpenAI format (includes tool results)
            meetings: Today's meetings for context
            user_timezone: User's timezone
            memory_context: Memory context from mem0.ai
            is_continuation: If True, don't add user message (it's already in history)
        
        Returns:
            Dict with 'content', 'function_calls', and 'assistant_message' (raw OpenAI message)
        """
        if conversation_history is None:
            conversation_history = []
        if meetings is None:
            meetings = []

        try:
            # Build system prompt
            system_prompt = self.build_system_prompt(meetings, user_timezone, memory_context)

            # Build messages array
            messages = [{'role': 'system', 'content': system_prompt}]
            
            # Add conversation history
            messages.extend(conversation_history)
            
            # FIX #2: Only add user message if it's NOT a continuation
            # (i.e., only on first iteration, and only if not already in history)
            if message and not is_continuation:
                messages.append({'role': 'user', 'content': message})

            # FIX #3: ALWAYS include tools - model needs them for multi-step workflows
            # Do NOT disable tools after tool results
            request_data = {
                'model': 'gpt-4o-mini',
                'messages': messages,
                'max_tokens': 1500,
                'temperature': 0.7,
                'tools': self.get_tools_definition(),
                'tool_choice': 'auto'
            }

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
            
            if 'choices' not in data or len(data['choices']) == 0:
                logger.error(f'Invalid OpenAI API response: no choices', response_data=data)
                raise Exception('Invalid OpenAI API response: no choices')
            
            message_obj = data['choices'][0]['message']
            
            # FIX #4: Keep tool_calls in exact OpenAI schema format
            function_calls = []
            if 'tool_calls' in message_obj and message_obj['tool_calls']:
                for tool_call in message_obj['tool_calls']:
                    if 'function' not in tool_call:
                        continue
                    
                    func_name = tool_call['function'].get('name')
                    func_args_str = tool_call['function'].get('arguments', '{}')
                    
                    # Parse arguments for executor, but keep original string for history
                    try:
                        func_args = json.loads(func_args_str) if isinstance(func_args_str, str) else func_args_str
                    except json.JSONDecodeError:
                        func_args = {}
                    
                    function_calls.append({
                        'id': tool_call.get('id'),
                        'type': 'function',
                        'function': {
                            'name': func_name,
                            'arguments': func_args_str  # Keep as string for OpenAI
                        },
                        # Also include parsed args for easier execution
                        '_parsed_arguments': func_args
                    })
            
            # FIX #6: Don't strip markdown - it corrupts JSON arguments
            response_text = message_obj.get('content', '').strip() if message_obj.get('content') else None
            
            result = {
                'content': response_text,  # Return raw, unmodified
                'function_calls': function_calls if function_calls else None,
                'assistant_message': message_obj  # Return full OpenAI message for history
            }
            
            return result
            
        except Exception as error:
            logger.error(f'Error generating chat response: {str(error)}')
            raise

    async def generate_initial_update(self, meetings: List[Dict[str, Any]]) -> str:
        """Generate initial update about today's meetings"""
        try:
            if not meetings or len(meetings) == 0:
                return "You have no meetings scheduled for today. I'm here to help whenever you need me!"

            meeting_list = []
            for idx, m in enumerate(meetings):
                start_time = m.get('start', {}).get('dateTime') or m.get('start', {}).get('date')
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
                        'model': 'gpt-4o-mini',
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
            return data['choices'][0]['message']['content'].strip()
            
        except Exception as error:
            logger.error(f'Error generating initial update: {str(error)}')
            return f"You have {len(meetings)} meeting{'s' if len(meetings) != 1 else ''} scheduled for today. Ready to help you prepare!"

    def build_system_prompt(self, meetings: List[Dict[str, Any]] = None, user_timezone: str = 'UTC', memory_context: Optional[str] = None) -> str:
        """
        Build system prompt with meeting context and current date/time
        FIX #7: Simplified system prompt to reduce token usage
        """
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
        tomorrow_date = (now_user_tz + timedelta(days=1)).strftime('%Y-%m-%d')
        yesterday_date = (now_user_tz - timedelta(days=1)).strftime('%Y-%m-%d')
        
        # FIX #7: Simplified, more concise system prompt
        prompt = f"""You are Shadow, an executive assistant AI.

CURRENT TIME ({user_timezone}): {current_day}, {current_date} at {current_time}
- "today" = {current_date}
- "tomorrow" = {tomorrow_date}
- "yesterday" = {yesterday_date}

TOOLS:
1. get_calendar_by_date(date) - Get calendar events. Date MUST be YYYY-MM-DD format.
2. generate_meeting_brief(meeting_id OR meeting) - Generate meeting prep. Prefer passing full meeting object.

RULES:
- Use tools when needed - don't guess calendar data
- Check conversation history for previous tool results before calling tools again
- After tool results, continue with more tools if needed (multi-step is OK)
- Keep responses concise (<150 words unless asked for detail)
- Be accurate - use tools to verify, don't assume"""
        
        # Add memory context as separate system context
        if memory_context:
            prompt += f"\n\nRELEVANT CONTEXT:\n{memory_context}"

        if meetings and len(meetings) > 0:
            prompt += "\n\nTODAY'S MEETINGS:\n"
            for idx, m in enumerate(meetings[:5]):  # Limit to 5 meetings to save tokens
                start_time = m.get('start', {}).get('dateTime') or m.get('start', {}).get('date')
                time_str = 'TBD'
                
                if start_time:
                    if m.get('start', {}).get('dateTime'):
                        try:
                            dt = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                            time_str = dt.strftime('%I:%M %p')
                        except:
                            pass
                    elif m.get('start', {}).get('date'):
                        time_str = 'All day'
                
                attendees = ', '.join([a.get('displayName') or a.get('email') for a in (m.get('attendees') or [])[:3]]) or 'No attendees'
                prompt += f"{idx + 1}. {m.get('summary', 'Untitled')} @ {time_str} - {attendees}\n"

        return prompt
