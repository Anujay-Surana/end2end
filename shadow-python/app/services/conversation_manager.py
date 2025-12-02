"""
Conversation Manager Service

Manages conversation history with sliding window approach - keeps last N messages active,
stores older messages in database for retrieval via mem0.ai
"""

from typing import List, Dict, Any, Optional
from app.db.queries.chat_messages import get_chat_messages, create_chat_message
from app.services.logger import logger
import json


class ConversationManager:
    """Manages conversation history with sliding window"""
    
    def __init__(self, window_size: int = 20):
        """
        Initialize conversation manager
        
        Args:
            window_size: Number of recent messages to keep in active context
        """
        self.window_size = window_size
    
    async def get_conversation_history(
        self,
        user_id: str,
        include_tool_calls: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Get conversation history with sliding window
        
        Args:
            user_id: User ID
            include_tool_calls: Whether to include tool calls in history
            
        Returns:
            List of messages in OpenAI format (last N messages)
        """
        try:
            # Load messages from database (we'll get more than window_size to ensure we have enough)
            db_messages = await get_chat_messages(
                user_id=user_id,
                limit=self.window_size * 2  # Get more than needed for filtering
            )
            
            # Build a map of tool_call_id -> tool result message for pairing
            tool_results_map = {}
            regular_messages = []
            
            # First pass: separate tool results from regular messages
            for msg in db_messages:
                metadata = msg.get('metadata', {})
                if not isinstance(metadata, dict):
                    metadata = {}
                
                # Tool results are stored with role='assistant' but marked with is_tool_result=True
                if metadata.get('is_tool_result'):
                    tool_call_id = metadata.get('tool_call_id')
                    if tool_call_id:
                        tool_results_map[tool_call_id] = msg
                else:
                    regular_messages.append(msg)
            
            # Convert to OpenAI format and apply sliding window
            # We want the most recent N messages, but keep them in chronological order (oldest first) for OpenAI
            all_formatted_messages = []
            
            # Process all messages in chronological order (oldest first)
            # Pair assistant messages with tool_calls with their tool results
            for msg in regular_messages:
                metadata = msg.get('metadata', {})
                
                # Regular messages (user, assistant, system)
                msg_dict = {
                    'role': msg['role'],
                    'content': msg['content'] or ''
                }
                
                # Include tool calls if present and requested
                if include_tool_calls:
                    tool_calls = metadata.get('tool_calls', [])
                    if tool_calls:
                        msg_dict['tool_calls'] = [
                            {
                                'id': tc.get('id', f"call_{idx}"),
                                'type': 'function',
                                'function': {
                                    'name': tc.get('name', 'unknown'),
                                    'arguments': tc.get('arguments') if isinstance(tc.get('arguments'), str) else json.dumps(tc.get('arguments', {}))
                                }
                            }
                            for idx, tc in enumerate(tool_calls)
                        ]
                
                all_formatted_messages.append(msg_dict)
                
                # If this assistant message has tool_calls, add corresponding tool results immediately after
                if msg_dict.get('role') == 'assistant' and msg_dict.get('tool_calls'):
                    for tool_call in msg_dict['tool_calls']:
                        tool_call_id = tool_call.get('id')
                        if tool_call_id and tool_call_id in tool_results_map:
                            tool_result_msg = tool_results_map[tool_call_id]
                            tool_metadata = tool_result_msg.get('metadata', {})
                            function_name = tool_metadata.get('function_name', 'unknown')
                            
                            # Format as OpenAI tool message - content is already JSON string
                            tool_msg = {
                                'role': 'tool',
                                'tool_call_id': tool_call_id,
                                'name': function_name,
                                'content': tool_result_msg.get('content', '{}')
                            }
                            all_formatted_messages.append(tool_msg)
            
            # Take the last N messages (most recent) but keep them in chronological order
            # OpenAI expects chronological order (oldest first), so we take the tail of the list
            conversation_history = all_formatted_messages[-self.window_size:] if len(all_formatted_messages) > self.window_size else all_formatted_messages
            
            return conversation_history
            
        except Exception as e:
            logger.error(f'Error loading conversation history: {str(e)}', userId=user_id)
            return []
    
    async def add_message_to_history(
        self,
        user_id: str,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Add a message to conversation history
        
        Args:
            user_id: User ID
            role: Message role ('user', 'assistant', 'system', 'tool')
            content: Message content
            metadata: Optional metadata
            
        Returns:
            Created message dict
        """
        try:
            message = await create_chat_message(
                user_id=user_id,
                role=role,
                content=content,
                metadata=metadata
            )
            
            return message
            
        except Exception as e:
            logger.error(f'Error adding message to history: {str(e)}', userId=user_id)
            raise
    
    def format_messages_for_openai(
        self,
        messages: List[Dict[str, Any]],
        include_tool_results: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Format messages for OpenAI API, including tool results
        
        Args:
            messages: List of message dicts
            include_tool_results: Whether to include tool result messages
            
        Returns:
            Formatted messages list
        """
        formatted = []
        
        for msg in messages:
            formatted_msg = {
                'role': msg.get('role'),
                'content': msg.get('content', '')
            }
            
            # Add tool calls if present
            if 'tool_calls' in msg:
                formatted_msg['tool_calls'] = msg['tool_calls']
            
            formatted.append(formatted_msg)
            
            # If this is an assistant message with tool calls, add tool results if available
            if include_tool_results and formatted_msg.get('tool_calls') and 'tool_result' in msg:
                tool_result = msg['tool_result']
                formatted.append({
                    'role': 'tool',
                    'tool_call_id': tool_result.get('tool_call_id'),
                    'name': tool_result.get('function_name'),
                    'content': json.dumps(tool_result.get('result', {}))
                })
        
        return formatted
    
    def get_conversation_summary(self, messages: List[Dict[str, Any]]) -> str:
        """
        Generate a summary of the conversation for long-term memory
        
        Args:
            messages: List of messages
            
        Returns:
            Summary string
        """
        if not messages:
            return ""
        
        # Simple summary: count messages and extract key topics
        user_messages = [m for m in messages if m.get('role') == 'user']
        assistant_messages = [m for m in messages if m.get('role') == 'assistant']
        
        summary_parts = [
            f"Conversation with {len(user_messages)} user messages and {len(assistant_messages)} assistant responses."
        ]
        
        # Extract first few user messages as context
        if user_messages:
            first_messages = user_messages[:3]
            topics = [m.get('content', '')[:100] for m in first_messages if m.get('content')]
            if topics:
                summary_parts.append(f"Topics discussed: {', '.join(topics)}")
        
        return " ".join(summary_parts)

