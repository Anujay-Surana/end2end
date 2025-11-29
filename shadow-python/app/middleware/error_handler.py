"""
Error Handler Middleware

Handles errors and returns consistent error responses
"""

from fastapi import Request, status
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from app.services.logger import logger


async def validation_exception_handler(request: Request, exc: RequestValidationError):
    """
    Handle validation errors
    """
    logger.warning(
        f"Validation error: {exc.errors()}",
        requestId=getattr(request.state, 'request_id', None),
        path=request.url.path,
        errors=exc.errors()
    )
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            'error': 'Validation error',
            'details': exc.errors()
        }
    )


async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    """
    Handle HTTP exceptions
    """
    logger.warning(
        f"HTTP {exc.status_code}: {exc.detail}",
        requestId=getattr(request.state, 'request_id', None),
        path=request.url.path,
        statusCode=exc.status_code,
        detail=exc.detail
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={
            'error': exc.detail or 'An error occurred'
        }
    )


async def general_exception_handler(request: Request, exc: Exception):
    """
    Handle general exceptions
    """
    logger.error(
        f"Unhandled exception: {str(exc)}",
        requestId=getattr(request.state, 'request_id', None),
        path=request.url.path,
        error=str(exc),
        exc_info=True
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            'error': 'Internal server error',
            'message': 'An unexpected error occurred'
        }
    )

