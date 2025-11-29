# Railway Deployment & Frontend Setup

## Python Version Configuration ✅

Railway is configured to use **Python 3.12**:

1. **`nixpacks.toml`** - Specifies `python312` in setup phase
2. **`shadow-python/runtime.txt`** - Specifies `python-3.12.0` for Railway detection
3. **Build process** - Uses `python -m ensurepip` and `python -m pip` (Python 3.12's pip)

Railway will automatically detect and use Python 3.12 when building.

## Frontend Serving Setup ✅

The FastAPI backend now serves the frontend (`index.html`) just like the old Express server did.

### How It Works:

1. **API Routes First** - All API routes (`/api/*`, `/auth/*`, `/ws/*`, etc.) are handled by FastAPI routers
2. **Static Files Second** - A catch-all route serves:
   - `index.html` for the root path (`/`)
   - Actual files if they exist (e.g., `/favicon.ico`, `/assets/*`)
   - `index.html` for SPA routes (client-side routing support)

### File Structure:
```
humanMax/
├── index.html          # Frontend (served by FastAPI)
├── shadow-python/      # Backend
│   └── app/
│       └── main.py     # Serves static files from project root
└── ...
```

### Route Priority:
1. `/health` - Health check (FastAPI route)
2. `/api/*` - API endpoints (FastAPI routers)
3. `/auth/*` - Authentication (FastAPI routers)
4. `/ws/*` - WebSocket (FastAPI routers)
5. `/docs` - API documentation (FastAPI)
6. `/*` - Frontend (catch-all route serves `index.html`)

### Security:
- Path traversal protection: Files are validated to be within the project root
- API routes are excluded from static file serving
- Only safe file types are served

## Testing Locally

The server is running and serving:
- ✅ Frontend at `http://localhost:8080/`
- ✅ API at `http://localhost:8080/api/*`
- ✅ Health check at `http://localhost:8080/health`
- ✅ API docs at `http://localhost:8080/docs`

## Railway Deployment

When deployed to Railway:
1. NIXPACKS detects Python 3.12 from `runtime.txt` and `nixpacks.toml`
2. Installs dependencies using Python 3.12's pip
3. Starts FastAPI server which serves both API and frontend
4. Frontend is accessible at the Railway URL root
5. API endpoints work as before

## Differences from Express Setup

**Old (Express):**
- `app.use(express.static(__dirname))` served everything from root
- Routes were mounted on top

**New (FastAPI):**
- Routes are registered first (higher priority)
- Catch-all route serves static files last
- Same end result: frontend + API from one server

