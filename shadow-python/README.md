# HumanMax Python Backend

Python 3.12 FastAPI backend for HumanMax meeting preparation calendar.

## Quick Start

### 1. Create virtual environment:
```bash
cd shadow-python
python3.12 -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

### 2. Install dependencies:
```bash
pip install -r requirements.txt
```

### 3. Set up environment variables

Create `.env` file in the project root (`/Users/anujaysurana/Desktop/humanMax/.env`) with:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `DEEPGRAM_API_KEY`
- Optional: `PARALLEL_API_KEY`, `JWT_SECRET`, `SESSION_SECRET`, `PORT`

### 4. Run the server:

**Recommended (avoids Python alias issues):**
```bash
cd shadow-python
./venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

**Alternative:**
```bash
cd shadow-python
source venv/bin/activate
python -m uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

### 5. Access the application:

- **Frontend:** http://localhost:8080/
- **API Docs:** http://localhost:8080/docs
- **Health Check:** http://localhost:8080/health

## Project Structure

```
shadow-python/
├── app/
│   ├── main.py              # FastAPI app entry point
│   ├── config.py            # Configuration and env vars
│   ├── routes/              # API routes
│   ├── middleware/          # FastAPI middleware
│   ├── services/            # Business logic services
│   └── db/                  # Database layer
├── requirements.txt         # Python dependencies
├── railway.json             # Railway deployment config
└── README.md
```

## Migration Status

This is a migration from Node.js/Express to Python/FastAPI. See the migration plan for details.

## Testing

### Running Tests

**Important**: Always use the venv Python to ensure dependencies are available.

```bash
# Activate virtual environment first
source venv/bin/activate

# Or use the venv Python directly
./venv/bin/python -m pytest tests/

# Run all tests
./venv/bin/python -m pytest tests/ -v

# Run with coverage
./venv/bin/python -m pytest tests/ --cov=app --cov-report=html

# Run specific test file
./venv/bin/python -m pytest tests/test_routes/test_auth.py -v

# Or use the test runner script
./run_tests.sh -v
```

### Test Structure

```
tests/
├── conftest.py          # Test fixtures and configuration
├── test_routes/         # Route endpoint tests
│   ├── test_auth.py
│   ├── test_accounts.py
│   ├── test_meetings.py
│   └── test_day_prep.py
├── test_services/       # Service layer tests
│   └── test_oauth.py
└── test_db/            # Database query tests
    └── test_queries.py
```

### Writing Tests

Tests use pytest with async support. Example:

```python
import pytest
from fastapi.testclient import TestClient

@pytest.mark.asyncio
async def test_endpoint(client):
    response = client.get('/health')
    assert response.status_code == 200
```

