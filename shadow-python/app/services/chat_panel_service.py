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
        """Get OpenAI tools definition for function calling"""
        return [
            {
                'type': 'function',
                'function': {
                    'name': 'get_calendar_by_date',
                    'description': 'Get calendar events/meetings for a specific date. Use this when the user asks about their calendar, meetings, or schedule for a particular date.',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'date': {
                                'type': 'string',
                                'description': 'Date in YYYY-MM-DD format (e.g., "2024-01-15")'
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
                    'description': 'Generate a detailed meeting brief/preparation document for a specific meeting. Use this when the user asks to prepare for a meeting, generate a brief, or get meeting prep.',
                    'parameters': {
                        'type': 'object',
                        'properties': {
                            'meeting_id': {
                                'type': 'string',
                                'description': 'The ID of the meeting to generate a brief for'
                            },
                            'meeting': {
                                'type': 'object',
                                'description': 'Meeting object with id, summary, start, end, attendees, etc. Use this if meeting_id is not available.',
                                'properties': {
                                    'id': {'type': 'string'},
                                    'summary': {'type': 'string'},
                                    'start': {'type': 'object'},
                                    'end': {'type': 'object'},
                                    'attendees': {'type': 'array'}
                                }
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
        function_results: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Generate chat response using OpenAI with function calling support
        Args:
            message: User message
            conversation_history: Previous messages in conversation
            meetings: Today's meetings for context
            function_results: Results from previous function calls (for follow-up)
        Returns:
            Dict with 'content' (response text) and optionally 'function_calls' (list of function calls to execute)
        """
        if conversation_history is None:
            conversation_history = []
        if meetings is None:
            meetings = []

        try:
            # Build system prompt
            system_prompt = self.build_system_prompt(meetings)

            # Build messages array
            messages = [
                {'role': 'system', 'content': system_prompt},
                *conversation_history,
            ]
            
            # Add function results if provided (from previous function calls)
            if function_results:
                messages.append({
                    'role': 'function',
                    'name': function_results.get('function_name'),
                    'content': json.dumps(function_results.get('result', {}))
                })
            
            # Add user message
            messages.append({'role': 'user', 'content': message})

            # Prepare request with tools
            request_data = {
                'model': 'gpt-4o-mini',  # Using gpt-4o-mini for function calling support
                'messages': messages,
                'max_tokens': 500,
                'temperature': 0.7,
                'tools': self.get_tools_definition(),
                'tool_choice': 'auto'  # Let model decide when to use tools
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
                raise Exception(f'OpenAI API error: {response.status_code}')

            data = response.json()
            message_obj = data['choices'][0]['message']
            
            # Check if model wants to call functions
            function_calls = []
            if 'tool_calls' in message_obj and message_obj['tool_calls']:
                for tool_call in message_obj['tool_calls']:
                    function_calls.append({
                        'id': tool_call['id'],
                        'name': tool_call['function']['name'],
                        'arguments': json.loads(tool_call['function']['arguments'])
                    })
            
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

    def build_system_prompt(self, meetings: List[Dict[str, Any]] = None) -> str:
        """
        Build system prompt with meeting context
        Args:
            meetings: Today's meetings
        Returns:
            System prompt
        """
        prompt = """You are Shadow, an executive assistant. You help users prepare for meetings and manage their day.

Your role:
- Provide quick, concise updates about meetings
- Answer questions about meeting attendees, times, and topics
- Help users prepare for upcoming meetings
- Be friendly, professional, and efficient

You have access to tools that let you:
- Get calendar events for any date (use get_calendar_by_date)
- Generate meeting briefs on demand (use generate_meeting_brief)

When users ask about their calendar or schedule, use get_calendar_by_date to fetch the data.
When users ask to prepare for a meeting or generate a brief, use generate_meeting_brief.

Keep responses brief and actionable. Maximum 100 words per response unless the user asks for more detail."""

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

