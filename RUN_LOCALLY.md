# How to Run the Project Locally

## Prerequisites

- Python 3.12 (recommended) or Python 3.10+
- pip (comes with Python)

## Step-by-Step Setup

### 1. Navigate to the project directory
```bash
cd /Users/anujaysurana/Desktop/humanMax
```

### 2. Set up Python virtual environment

```bash
cd shadow-python
python3.12 -m venv venv
```

If you don't have Python 3.12 specifically:
```bash
python3 -m venv venv
```

### 3. Activate the virtual environment

**On macOS/Linux:**
```bash
source venv/bin/activate
```

**On Windows:**
```bash
venv\Scripts\activate
```

### 4. Install dependencies

```bash
pip install -r requirements.txt
```

### 5. Set up environment variables

Make sure you have a `.env` file in the project root (`/Users/anujaysurana/Desktop/humanMax/.env`) with all required variables:

```env
# Supabase
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# OpenAI
OPENAI_API_KEY=your_openai_key

# Google OAuth
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret

# Deepgram
DEEPGRAM_API_KEY=your_deepgram_key

# Optional
PARALLEL_API_KEY=your_parallel_key
JWT_SECRET=your_jwt_secret
SESSION_SECRET=your_session_secret
PORT=8080
```

### 6. Run the server

**Option A: Using uvicorn directly (recommended)**
```bash
cd shadow-python
./venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

**Option B: Using the venv Python**
```bash
cd shadow-python
source venv/bin/activate
python -m uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

**Option C: Using Python directly**
```bash
cd shadow-python
python -m uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

**Note:** If you get import errors, use Option A (direct path to venv Python) to avoid Python version conflicts.

### 7. Access the application

- **Frontend:** http://localhost:8080/
- **API Health Check:** http://localhost:8080/health
- **API Documentation:** http://localhost:8080/docs
- **API Endpoints:** http://localhost:8080/api/*

## Troubleshooting

### Import Errors (ModuleNotFoundError)

If you see `ModuleNotFoundError: No module named 'supabase'` or similar:

**Problem:** Your shell has a Python alias that overrides the venv Python.

**Solution:** Use the venv Python directly:
```bash
cd shadow-python
./venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

### Port Already in Use

If port 8080 is already in use (common after stopping server with Ctrl+C):

**Option 1:** Use the helper script:
```bash
./kill-port.sh
# or specify a different port:
./kill-port.sh 3000
```

**Option 2:** Kill manually:
```bash
lsof -ti:8080 | xargs kill -9
```

**Option 3:** Use a different port:
```bash
python -m uvicorn app.main:app --host 0.0.0.0 --port 3000 --reload
```

Then access at `http://localhost:3000`

**Note:** The `start.sh` script now automatically kills any existing process on port 8080 before starting.

### Environment Variables Not Found

Make sure your `.env` file is in the project root (`/Users/anujaysurana/Desktop/humanMax/.env`), not in `shadow-python/`.

The app uses `python-dotenv` which looks for `.env` in the current working directory and parent directories.

### Python Version Mismatch

Check your Python version:
```bash
python --version
```

If it's not 3.12, you can:
1. Install Python 3.12
2. Or use Python 3.10+ (should work but 3.12 is recommended)

## Quick Start Scripts

### Start Server (`start.sh`)

The `start.sh` script automatically kills any existing process on port 8080 and starts the server:

```bash
./start.sh
```

This script:
- ✅ Kills any existing process on port 8080
- ✅ Starts the server with auto-reload

### Kill Port (`kill-port.sh`)

If you need to manually free up a port:

```bash
./kill-port.sh        # Kills port 8080 (default)
./kill-port.sh 3000   # Kills port 3000
```

## Development Tips

- The `--reload` flag enables auto-reload on code changes
- Check logs in the terminal for errors
- Use `http://localhost:8080/docs` to test API endpoints interactively
- Frontend changes to `index.html` will be reflected immediately (no rebuild needed)

