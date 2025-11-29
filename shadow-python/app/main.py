"""
FastAPI Main Application

Entry point for the Python backend
"""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
import os
from app.config import settings, validate_env
from app.db.connection import test_connection
from app.middleware.request_logger import RequestLoggerMiddleware
from app.middleware.error_handler import (
    validation_exception_handler,
    http_exception_handler,
    general_exception_handler
)
from app.middleware.rate_limiter import limiter
from slowapi.errors import RateLimitExceeded
from app.services.logger import logger
from app.services.session_cleanup import start_periodic_cleanup

# Validate environment variables
if not validate_env():
    exit(1)

# Create FastAPI app
app = FastAPI(
    title="HumanMax Backend API",
    description="Meeting preparation calendar with AI integration",
    version="1.0.0"
)

# Trust proxy (for Railway)
app.root_path = os.getenv('ROOT_PATH', '')

# CORS configuration
cors_origins = os.getenv('ALLOWED_ORIGINS', '').split(',') if os.getenv('ALLOWED_ORIGINS') else ['*']

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins if cors_origins != ['*'] else ['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

# Add request logging middleware
app.add_middleware(RequestLoggerMiddleware)

# Add rate limiting
app.state.limiter = limiter

# Add error handlers
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(StarletteHTTPException, http_exception_handler)
app.add_exception_handler(Exception, general_exception_handler)


# Health check endpoint
@app.get('/health')
async def health_check():
    """Health check endpoint"""
    return {'status': 'ok', 'service': 'humanmax-backend'}


# Startup event
@app.on_event('startup')
async def startup_event():
    """Initialize services on startup"""
    logger.info('Starting HumanMax Backend...')
    
    # Test database connection
    connected = await test_connection()
    if not connected:
        logger.warning('Database connection failed - some features may not work')
    
    # Start session cleanup
    start_periodic_cleanup()
    
    logger.info('HumanMax Backend started successfully')


# Shutdown event
@app.on_event('shutdown')
async def shutdown_event():
    """Cleanup on shutdown"""
    logger.info('Shutting down HumanMax Backend...')


# Import routes
from app.routes import auth_enhanced, accounts, meetings, day_prep, parallel, tts, websocket, onboarding, credentials, service_auth, chat_panel

app.include_router(auth_enhanced.router, prefix='/auth', tags=['auth'])
app.include_router(accounts.router, prefix='/api/accounts', tags=['accounts'])
app.include_router(meetings.router, prefix='/api', tags=['meetings'])
app.include_router(day_prep.router, prefix='/api', tags=['day-prep'])
app.include_router(parallel.router, prefix='/api/parallel', tags=['parallel'])
app.include_router(tts.router, prefix='/api', tags=['tts'])
app.include_router(chat_panel.router, prefix='/api', tags=['chat-panel'])
app.include_router(websocket.router, prefix='/ws', tags=['websocket'])
app.include_router(onboarding.router, prefix='/onboarding', tags=['onboarding'])
app.include_router(credentials.router, prefix='', tags=['credentials'])
app.include_router(service_auth.router, prefix='/auth', tags=['service-auth'])


if __name__ == '__main__':
    import uvicorn
    port = int(os.getenv('PORT', '8080'))
    uvicorn.run(app, host='0.0.0.0', port=port)

