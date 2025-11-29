"""
Parallel AI Routes

Parallel AI search and extraction endpoints
"""

from fastapi import APIRouter, Depends
from app.middleware.auth import require_auth
# Rate limiting will be added via middleware
from app.services.logger import logger

router = APIRouter()


@router.post('/search')
async def parallel_search(
    request_body: dict,
    user=Depends(require_auth)
):
    """
    Parallel AI web search
    Accepts: { objective, search_queries, mode, max_results, max_chars_per_result }
    Returns: { results: [...] }
    """
    # TODO: Implement parallel search with actual Parallel AI integration
    logger.info('Parallel search requested', userId=user.get('id'))
    # Return empty results for now (endpoint exists but not implemented)
    return {'results': []}


@router.post('/extract')
async def parallel_extract(user=Depends(require_auth)):
    """
    Parallel AI content extraction
    """
    # TODO: Implement parallel extract
    logger.info('Parallel extract requested')
    return {'extracted': []}


@router.post('/research')
async def parallel_research(user=Depends(require_auth)):
    """
    Parallel AI research
    """
    # TODO: Implement parallel research
    logger.info('Parallel research requested')
    return {'research': []}

