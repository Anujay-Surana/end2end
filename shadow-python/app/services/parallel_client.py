"""
Parallel AI Client Service

Provides a client interface for Parallel AI API calls
"""

import httpx
from typing import Dict, List, Any, Optional
from app.config import settings
from app.services.logger import logger


class ParallelBeta:
    """Parallel AI Beta API methods"""
    
    def __init__(self, api_key: str, base_url: str):
        self.api_key = api_key
        self.base_url = base_url
    
    async def search(
        self,
        objective: str,
        search_queries: List[str],
        max_results: int = 8,
        max_chars_per_result: int = 2500,
        processor: str = "base"
    ) -> Dict[str, Any]:
        """
        Perform web search using Parallel AI
        
        Args:
            objective: Search objective/description (natural language)
            search_queries: List of search queries
            max_results: Maximum number of results (default: 8)
            max_chars_per_result: Maximum characters per result (default: 2500)
            processor: Processor type (default: "base")
            
        Returns:
            Dict with 'results' key containing list of search results and 'search_id'
        """
        if not self.api_key or not self.api_key.strip():
            logger.warn("Parallel AI client not available - no API key configured")
            return {'results': []}
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                # Correct endpoint: /v1beta/search (not /v1/beta/search)
                # Correct auth: x-api-key header (not Authorization Bearer)
                response = await client.post(
                    f"{self.base_url}beta/search",
                    headers={
                        "x-api-key": self.api_key,
                        "Content-Type": "application/json"
                    },
                    json={
                        "objective": objective,
                        "search_queries": search_queries,
                        "max_results": max_results,
                        "max_chars_per_result": max_chars_per_result,
                        "processor": processor
                    }
                )
                
                if response.is_success:
                    return response.json()
                else:
                    logger.error(
                        f"Parallel AI search failed: HTTP {response.status_code}",
                        statusCode=response.status_code,
                        responseText=response.text[:200]
                    )
                    return {'results': []}
        except Exception as e:
            logger.error(f"Parallel AI search error: {str(e)}", error=str(e))
            return {'results': []}


class ParallelClient:
    """Parallel AI API client"""
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or settings.PARALLEL_API_KEY
        self.base_url = "https://api.parallel.ai/v1"
        # Create beta sub-object to match expected interface: parallel_client.beta.search()
        self.beta = ParallelBeta(self.api_key, self.base_url)
        
    def is_available(self) -> bool:
        """Check if Parallel AI client is available (has API key)"""
        return bool(self.api_key and self.api_key.strip())


def get_parallel_client() -> Optional[ParallelClient]:
    """Get Parallel AI client instance if API key is configured"""
    if settings.PARALLEL_API_KEY and settings.PARALLEL_API_KEY.strip():
        return ParallelClient()
    return None

