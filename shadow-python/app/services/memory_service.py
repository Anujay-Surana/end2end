"""
Memory Service

Integrates with mem0.ai for long-term memory storage and retrieval
"""

from typing import List, Dict, Any, Optional
from app.config import settings
from app.services.logger import logger
import httpx
import json


class MemoryService:
    """Service for managing long-term memories with mem0.ai"""
    
    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize memory service
        
        Args:
            api_key: mem0.ai API key (optional, uses config if not provided)
        """
        self.api_key = api_key or settings.MEM0_API_KEY
        self.base_url = "https://api.mem0.ai/v1"
        self.enabled = bool(self.api_key)
        self.token_invalid = False  # Track if token is invalid to avoid repeated errors
        
        if not self.enabled:
            logger.debug('mem0.ai API key not configured - memory features disabled')
    
    async def add_memory(
        self,
        user_id: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Add a memory to mem0.ai
        
        Args:
            user_id: User ID (used as memory source ID)
            content: Memory content/text
            metadata: Optional metadata
            
        Returns:
            Created memory dict or None if disabled
        """
        if not self.enabled or self.token_invalid:
            return None
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{self.base_url}/memories/",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "source_id": user_id,
                        "content": content,
                        "metadata": metadata or {}
                    }
                )
                
                if response.is_success:
                    memory = response.json()
                    logger.debug(f'Added memory to mem0.ai', userId=user_id, memory_id=memory.get('id'))
                    return memory
                elif response.status_code == 401:
                    # Token invalid - disable service to avoid repeated errors
                    self.token_invalid = True
                    self.enabled = False
                    logger.warning('mem0.ai API token invalid - disabling memory features', userId=user_id)
                    return None
                else:
                    logger.debug(f'mem0.ai API error: {response.status_code}', userId=user_id)
                    return None
                    
        except Exception as e:
            logger.error(f'Error adding memory to mem0.ai: {str(e)}', userId=user_id)
            return None
    
    async def search_memories(
        self,
        user_id: str,
        query: str,
        limit: int = 5
    ) -> List[Dict[str, Any]]:
        """
        Search for relevant memories
        
        Args:
            user_id: User ID (memory source ID)
            query: Search query
            limit: Maximum number of memories to return
            
        Returns:
            List of relevant memories
        """
        if not self.enabled or self.token_invalid:
            return []
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    f"{self.base_url}/memories/search/",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "source_id": user_id,
                        "query": query,
                        "limit": limit
                    }
                )
                
                if response.is_success:
                    data = response.json()
                    memories = data.get('results', [])
                    logger.debug(f'Found {len(memories)} relevant memories', userId=user_id)
                    return memories
                elif response.status_code == 401:
                    # Token invalid - disable service to avoid repeated errors
                    self.token_invalid = True
                    self.enabled = False
                    logger.warning('mem0.ai API token invalid - disabling memory features', userId=user_id)
                    return []
                else:
                    logger.debug(f'mem0.ai search error: {response.status_code}', userId=user_id)
                    return []
                    
        except Exception as e:
            logger.error(f'Error searching memories: {str(e)}', userId=user_id)
            return []
    
    async def get_all_memories(
        self,
        user_id: str,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Get all memories for a user
        
        Args:
            user_id: User ID (memory source ID)
            limit: Maximum number of memories to return
            
        Returns:
            List of memories
        """
        if not self.enabled or self.token_invalid:
            return []
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{self.base_url}/memories/",
                    headers={
                        "Authorization": f"Bearer {self.api_key}"
                    },
                    params={
                        "source_id": user_id,
                        "limit": limit
                    }
                )
                
                if response.is_success:
                    data = response.json()
                    memories = data.get('results', [])
                    logger.debug(f'Retrieved {len(memories)} memories', userId=user_id)
                    return memories
                elif response.status_code == 401:
                    # Token invalid - disable service
                    self.token_invalid = True
                    self.enabled = False
                    logger.warning('mem0.ai API token invalid - disabling memory features', userId=user_id)
                    return []
                else:
                    logger.debug(f'mem0.ai get error: {response.status_code}', userId=user_id)
                    return []
                    
        except Exception as e:
            logger.error(f'Error getting memories: {str(e)}', userId=user_id)
            return []
    
    async def delete_memory(self, memory_id: str) -> bool:
        """
        Delete a memory
        
        Args:
            memory_id: Memory ID
            
        Returns:
            Success status
        """
        if not self.enabled or self.token_invalid:
            return False
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.delete(
                    f"{self.base_url}/memories/{memory_id}/",
                    headers={
                        "Authorization": f"Bearer {self.api_key}"
                    }
                )
                
                if response.is_success:
                    logger.debug(f'Deleted memory {memory_id}')
                    return True
                elif response.status_code == 401:
                    # Token invalid - disable service
                    self.token_invalid = True
                    self.enabled = False
                    logger.warning('mem0.ai API token invalid - disabling memory features')
                    return False
                else:
                    logger.debug(f'mem0.ai delete error: {response.status_code}')
                    return False
                    
        except Exception as e:
            logger.error(f'Error deleting memory: {str(e)}')
            return False
    
    def format_memories_for_context(self, memories: List[Dict[str, Any]]) -> str:
        """
        Format memories for inclusion in AI context
        
        Args:
            memories: List of memory dicts
            
        Returns:
            Formatted string for context
        """
        if not memories:
            return ""
        
        formatted = ["Relevant context from past conversations:"]
        for idx, memory in enumerate(memories, 1):
            content = memory.get('memory', memory.get('content', ''))
            if content:
                formatted.append(f"{idx}. {content}")
        
        return "\n".join(formatted)

