#!/bin/bash
# Quick start script for HumanMax backend

# Kill any existing process on port 8080
echo "🔍 Checking for existing server on port 8080..."
PIDS=$(lsof -ti:8080 2>/dev/null)
if [ ! -z "$PIDS" ]; then
    echo "🛑 Killing existing processes on port 8080..."
    echo $PIDS | xargs kill -9 2>/dev/null
    sleep 1
fi

cd shadow-python
./venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
