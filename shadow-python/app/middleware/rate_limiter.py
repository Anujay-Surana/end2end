"""
Rate Limiter Middleware

Provides rate limiting for API endpoints using slowapi
"""

from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from fastapi import Request
from starlette.responses import JSONResponse
import os

# Initialize limiter
limiter = Limiter(key_func=get_remote_address)

# Rate limiters for different endpoints
auth_limiter = limiter.limit("10/minute")
meeting_prep_limiter = limiter.limit("20/hour")
parallel_ai_limiter = limiter.limit("30/hour")
tts_limiter = limiter.limit("100/hour")


def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    """
    Custom handler for rate limit exceeded
    """
    response = JSONResponse(
        status_code=429,
        content={
            'error': 'Rate limit exceeded',
            'message': f'Too many requests. Limit: {exc.detail}'
        }
    )
    response = request.app.state.limiter._inject_headers(
        response, request.state.view_rate_limit
    )
    return response

