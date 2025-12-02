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
        meeting_id: Optional[str] = None,
        include_tool_calls: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Get conversation history with sliding window
        
        Args:
            user_id: User ID
            meeting_id: Optional meeting ID filter
            include_tool_calls: Whether to include tool calls in history
            
        Returns:
            List of messages in OpenAI format (last N messages)
        """
        try:
            # Load messages from database (we'll get more than window_size to ensure we have enough)
            db_messages = await get_chat_messages(
                user_id=user_id,
                meeting_id=meeting_id,
                limit=self.window_size * 2  # Get more than needed for filtering
            )
            
            # Build a map of tool_call_id -> tool result message for pairing
            tool_results_map = {}
            regular_messages = []
            
            # Debug: Inspect metadata from database
            metadata_samples = []
            messages_with_metadata = 0
            messages_with_empty_metadata = 0
            messages_with_none_metadata = 0
            
            # First pass: separate tool results from regular messages
            for idx, msg in enumerate(db_messages):
                # Inspect metadata structure
                raw_metadata = msg.get('metadata')
                if raw_metadata is None:
                    messages_with_none_metadata += 1
                    metadata = {}
                elif isinstance(raw_metadata, dict):
                    if raw_metadata:
                        messages_with_metadata += 1
                        metadata = raw_metadata
                        # Sample first few messages with metadata
                        if len(metadata_samples) < 3:
                            metadata_samples.append({
                                'index': idx,
                                'role': msg.get('role'),
                                'content_preview': str(msg.get('content', ''))[:50],
                                'metadata': raw_metadata,
                                'has_is_tool_result': raw_metadata.get('is_tool_result', False)
                            })
                    else:
                        messages_with_empty_metadata += 1
                        metadata = {}
                else:
                    # Metadata is not a dict (could be string, etc.)
                    logger.warning(
                        f'Unexpected metadata type: {type(raw_metadata)}',
                        userId=user_id,
                        message_index=idx,
                        metadata_type=str(type(raw_metadata)),
                        metadata_value=str(raw_metadata)[:100]
                    )
                    metadata = {}
                
                # Check for tool result - multiple detection methods
                is_tool_result = False
                tool_call_id = None
                
                # Method 1: Check metadata flag
                if metadata.get('is_tool_result'):
                    is_tool_result = True
                    tool_call_id = metadata.get('tool_call_id')
                
                # Method 2: Fallback - check if content is JSON and matches tool result pattern
                # Tool results have JSON content with keys like 'date', 'meetings', 'count', etc.
                if not is_tool_result and msg.get('content'):
                    try:
                        content_str = msg.get('content', '')
                        if content_str.startswith('{') and content_str.endswith('}'):
                            parsed_content = json.loads(content_str)
                            # Check if it looks like a tool result (has common tool result keys)
                            if isinstance(parsed_content, dict):
                                tool_result_indicators = ['date', 'meetings', 'count', 'error', 'brief', 'summary']
                                if any(key in parsed_content for key in tool_result_indicators):
                                    # Try to find tool_call_id in metadata or content
                                    is_tool_result = True
                                    tool_call_id = metadata.get('tool_call_id') or parsed_content.get('tool_call_id')
                                    logger.info(
                                        f'Detected tool result via content pattern',
                                        userId=user_id,
                                        message_index=idx,
                                        content_keys=list(parsed_content.keys())[:5],
                                        tool_call_id=tool_call_id
                                    )
                    except (json.JSONDecodeError, TypeError):
                        pass  # Not JSON, skip
                
                if is_tool_result:
                    if tool_call_id:
                        tool_results_map[tool_call_id] = msg
                        logger.debug(
                            f'Found tool result message',
                            userId=user_id,
                            tool_call_id=tool_call_id,
                            function_name=metadata.get('function_name'),
                            has_result=bool(metadata.get('function_result')),
                            detection_method='metadata' if metadata.get('is_tool_result') else 'content_pattern'
                        )
                    else:
                        logger.warning(
                            f'Tool result message missing tool_call_id',
                            userId=user_id,
                            message_index=idx,
                            metadata_keys=list(metadata.keys()),
                            content_preview=str(msg.get('content', ''))[:100]
                        )
                else:
                    regular_messages.append(msg)
            
            # Log metadata inspection results
            logger.info(
                f'Metadata inspection complete',
                userId=user_id,
                total_messages=len(db_messages),
                messages_with_metadata=messages_with_metadata,
                messages_with_empty_metadata=messages_with_empty_metadata,
                messages_with_none_metadata=messages_with_none_metadata,
                metadata_samples=metadata_samples,
                tool_results_found=len(tool_results_map)
            )
            
            logger.info(
                f'Separated messages: {len(regular_messages)} regular, {len(tool_results_map)} tool results',
                userId=user_id,
                regular_count=len(regular_messages),
                tool_results_count=len(tool_results_map),
                tool_call_ids=list(tool_results_map.keys())
            )
            
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
                if include_tool_calls and metadata.get('has_tool_calls'):
                    tool_calls = metadata.get('function_calls', [])
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
                            function_result = tool_metadata.get('function_result', {})
                            
                            logger.debug(
                                f'Adding tool result to conversation history',
                                userId=user_id,
                                tool_call_id=tool_call_id,
                                function_name=function_name,
                                result_keys=list(function_result.keys()) if isinstance(function_result, dict) else None
                            )
                            
                            # Format as OpenAI tool message
                            tool_msg = {
                                'role': 'tool',
                                'tool_call_id': tool_call_id,
                                'name': function_name,
                                'content': json.dumps(function_result) if isinstance(function_result, dict) else str(function_result)
                            }
                            all_formatted_messages.append(tool_msg)
                        else:
                            logger.warning(
                                f'Tool result not found for tool_call_id',
                                userId=user_id,
                                tool_call_id=tool_call_id,
                                available_tool_call_ids=list(tool_results_map.keys())
                            )
            
            # Take the last N messages (most recent) but keep them in chronological order
            # OpenAI expects chronological order (oldest first), so we take the tail of the list
            conversation_history = all_formatted_messages[-self.window_size:] if len(all_formatted_messages) > self.window_size else all_formatted_messages
            
            # Log conversation history details for debugging
            tool_results_count = sum(1 for m in conversation_history if m.get('role') == 'tool')
            assistant_with_tools_count = sum(1 for m in conversation_history if m.get('tool_calls'))
            logger.info(
                f'Loaded {len(conversation_history)} messages for conversation history',
                userId=user_id,
                total_messages=len(conversation_history),
                tool_results_count=tool_results_count,
                assistant_with_tools_count=assistant_with_tools_count,
                message_types={m.get('role'): sum(1 for msg in conversation_history if msg.get('role') == m.get('role')) for m in conversation_history}
            )
            
            return conversation_history
            
        except Exception as e:
            logger.error(f'Error loading conversation history: {str(e)}', userId=user_id)
            return []
    
    async def add_message_to_history(
        self,
        user_id: str,
        role: str,
        content: str,
        meeting_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Add a message to conversation history
        
        Args:
            user_id: User ID
            role: Message role ('user', 'assistant', 'system')
            content: Message content
            meeting_id: Optional meeting ID
            metadata: Optional metadata
            
        Returns:
            Created message dict
        """
        try:
            message = await create_chat_message(
                user_id=user_id,
                role=role,
                content=content,
                meeting_id=meeting_id,
                metadata=metadata
            )
            
            logger.debug(f'Added {role} message to conversation history', userId=user_id)
            
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

