"""
Google API Retry Service

Provides retry logic for Google API calls with exponential backoff
"""

import asyncio
import httpx
from typing import Dict, Any


async def fetch_with_retry(
    url: str,
    options: Dict[str, Any] = None,
    max_retries: int = 3,
    timeout: int = 60000  # 60 seconds
) -> httpx.Response:
    """
    Fetch with automatic retry on failure
    Args:
        url: URL to fetch
        options: Request options (headers, etc.)
        max_retries: Maximum number of retries
        timeout: Timeout in milliseconds
    Returns:
        Response object
    """
    if options is None:
        options = {}
    
    headers = options.get('headers', {})
    
    async with httpx.AsyncClient(timeout=timeout / 1000) as client:
        for attempt in range(max_retries + 1):
            try:
                response = await client.get(url, headers=headers)
                
                # Handle 408 timeout errors with retry
                if response.status_code == 408:
                    if attempt < max_retries:
                        wait_time = (2 ** attempt) * 1000  # Exponential backoff: 1s, 2s, 4s
                        await asyncio.sleep(wait_time / 1000)
                        continue
                    else:
                        raise Exception(f'Request timeout after {max_retries} retries')
                
                # Handle 429 rate limit errors
                if response.status_code == 429:
                    retry_after = response.headers.get('retry-after')
                    if retry_after and attempt < max_retries:
                        wait_time = float(retry_after) * 1000
                        await asyncio.sleep(wait_time / 1000)
                        continue
                    elif attempt < max_retries:
                        wait_time = (2 ** attempt) * 2000  # Exponential backoff
                        await asyncio.sleep(wait_time / 1000)
                        continue
                
                return response
                
            except httpx.TimeoutException:
                if attempt < max_retries:
                    wait_time = (2 ** attempt) * 1000
                    await asyncio.sleep(wait_time / 1000)
                    continue
                else:
                    raise Exception(f'Request timeout after {max_retries} retries')
            except Exception as e:
                if attempt < max_retries:
                    wait_time = (2 ** attempt) * 1000
                    await asyncio.sleep(wait_time / 1000)
                    continue
                else:
                    raise
    
    raise Exception(f'Failed after {max_retries} retries')

