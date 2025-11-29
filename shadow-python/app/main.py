"""
FastAPI Main Application

Entry point for the Python backend
"""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
import os
from pathlib import Path
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


# Root endpoint removed - handled by serve_frontend below

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

# Serve static files (frontend) - must be after API routes
# Get the project root directory (parent of shadow-python)
# main.py is at: shadow-python/app/main.py
# So we go up 2 levels: shadow-python/app -> shadow-python -> project_root
_current_file = Path(__file__).resolve()
project_root = _current_file.parent.parent.parent
static_dir = project_root

# Serve static files (frontend) - catch-all route must be last
@app.get('/{full_path:path}')
async def serve_frontend(full_path: str, request: Request):
    """
    Serve frontend files. API routes are handled above, so this catches everything else.
    This enables SPA routing - all non-API routes serve index.html.
    """
    # Don't serve API routes or other backend paths (these should be handled by routers above)
    if full_path.startswith(('api/', 'auth/', 'ws/', 'onboarding/', 'docs', 'openapi.json', 'health', '_')):
        raise StarletteHTTPException(status_code=404, detail="Not found")
    
    # Serve index.html for root path
    if full_path == '':
        index_path = static_dir / 'index.html'
        if index_path.exists():
            return FileResponse(index_path)
        raise StarletteHTTPException(status_code=404, detail="Frontend not found")
    
    # Try to serve the requested file if it exists
    file_path = static_dir / full_path
    # Security: ensure the resolved path is still within static_dir
    try:
        file_path_resolved = file_path.resolve()
        static_dir_resolved = static_dir.resolve()
        if file_path_resolved.exists() and file_path_resolved.is_file():
            # Check that the file is within the static directory (prevent directory traversal)
            if str(file_path_resolved).startswith(str(static_dir_resolved)):
                return FileResponse(file_path_resolved)
    except (OSError, ValueError):
        pass  # Invalid path, fall through to SPA routing
    
    # For SPA routing, serve index.html for any path that doesn't match a file
    # This allows client-side routing to work
    index_path = static_dir / 'index.html'
    if index_path.exists():
        return FileResponse(index_path)
    
    raise StarletteHTTPException(status_code=404, detail="Not found")


if __name__ == '__main__':
    import uvicorn
    port = int(os.getenv('PORT', '8080'))
    uvicorn.run(app, host='0.0.0.0', port=port)

