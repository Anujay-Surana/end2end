"""
Chat Panel Service

Handles OpenAI chat integration for the chat panel interface
"""

import re
import httpx
import os
from datetime import datetime
from typing import List, Dict, Any, Optional
from app.services.logger import logger


class ChatPanelService:
    def __init__(self, openai_api_key: str):
        self.openai_api_key = openai_api_key

    async def generate_response(
        self,
        message: str,
        conversation_history: List[Dict[str, str]] = None,
        meetings: List[Dict[str, Any]] = None
    ) -> str:
        """
        Generate chat response using OpenAI
        Args:
            message: User message
            conversation_history: Previous messages in conversation
            meetings: Today's meetings for context
        Returns:
            AI response
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
                {'role': 'user', 'content': message}
            ]

            async with httpx.AsyncClient() as client:
                response = await client.post(
                    'https://api.openai.com/v1/chat/completions',
                    headers={
                        'Content-Type': 'application/json',
                        'Authorization': f'Bearer {self.openai_api_key}'
                    },
                    json={
                        'model': 'gpt-4.1-mini',
                        'messages': messages,
                        'max_tokens': 300,
                        'temperature': 0.7
                    }
                )

            if not response.is_success:
                error_data = response.text
                logger.error(f'OpenAI API error: {response.status_code} - {error_data}')
                raise Exception(f'OpenAI API error: {response.status_code}')

            data = response.json()
            response_text = data['choices'][0]['message']['content'].strip()
            # Strip markdown formatting for clean display
            return self.strip_markdown(response_text)
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

