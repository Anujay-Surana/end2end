"""
Parallel AI Client Service

Provides a client interface for Parallel AI API calls
"""

import httpx
from typing import Dict, List, Any, Optional
from app.config import settings
from app.services.logger import logger


class ParallelClient:
    """Parallel AI API client"""
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or settings.PARALLEL_API_KEY
        self.base_url = "https://api.parallel.ai/v1"
        
    def is_available(self) -> bool:
        """Check if Parallel AI client is available (has API key)"""
        return bool(self.api_key and self.api_key.strip())
    
    async def beta_search(
        self,
        objective: str,
        search_queries: List[str],
        mode: str = "one-shot",
        max_results: int = 8,
        max_chars_per_result: int = 2500
    ) -> Dict[str, Any]:
        """
        Perform web search using Parallel AI
        
        Args:
            objective: Search objective/description
            search_queries: List of search queries
            mode: Search mode (default: "one-shot")
            max_results: Maximum number of results (default: 8)
            max_chars_per_result: Maximum characters per result (default: 2500)
            
        Returns:
            Dict with 'results' key containing list of search results
        """
        if not self.is_available():
            logger.warn("Parallel AI client not available - no API key configured")
            return {'results': []}
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self.base_url}/beta/search",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "objective": objective,
                        "search_queries": search_queries,
                        "mode": mode,
                        "max_results": max_results,
                        "max_chars_per_result": max_chars_per_result
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


def get_parallel_client() -> Optional[ParallelClient]:
    """Get Parallel AI client instance if API key is configured"""
    if settings.PARALLEL_API_KEY and settings.PARALLEL_API_KEY.strip():
        return ParallelClient()
    return None

