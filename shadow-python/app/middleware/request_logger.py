"""
Request Logger Middleware

Logs all incoming requests with timing information
"""

import time
import uuid
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from app.services.logger import logger


class RequestLoggerMiddleware(BaseHTTPMiddleware):
    """Middleware to log all requests with timing"""

    async def dispatch(self, request: Request, call_next):
        # Generate request ID
        request_id = str(uuid.uuid4())[:8]
        request.state.request_id = request_id

        # Start timer
        start_time = time.time()

        # Log request
        logger.info(
            f"→ {request.method} {request.url.path}",
            requestId=request_id,
            method=request.method,
            path=request.url.path,
            queryParams=dict(request.query_params),
            clientIp=request.client.host if request.client else None
        )

        try:
            # Process request
            response = await call_next(request)

            # Calculate duration
            duration_ms = (time.time() - start_time) * 1000

            # Log response
            logger.info(
                f"← {request.method} {request.url.path} {response.status_code} ({duration_ms:.1f}ms)",
                requestId=request_id,
                method=request.method,
                path=request.url.path,
                statusCode=response.status_code,
                durationMs=duration_ms
            )

            return response
        except Exception as error:
            # Calculate duration
            duration_ms = (time.time() - start_time) * 1000

            # Log error
            logger.error(
                f"✗ {request.method} {request.url.path} ERROR ({duration_ms:.1f}ms)",
                requestId=request_id,
                method=request.method,
                path=request.url.path,
                error=str(error),
                durationMs=duration_ms
            )
            raise

