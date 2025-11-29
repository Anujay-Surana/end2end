#!/bin/bash
# Quick script to kill any process using port 8080

PORT=${1:-8080}

echo "🔍 Checking for processes on port $PORT..."

PIDS=$(lsof -ti:$PORT)

if [ -z "$PIDS" ]; then
    echo "✅ No process found on port $PORT"
    exit 0
fi

echo "Found processes: $PIDS"
echo "🛑 Killing processes..."

for PID in $PIDS; do
    kill -9 $PID 2>/dev/null && echo "  ✅ Killed PID $PID" || echo "  ⚠️  Failed to kill PID $PID"
done

echo "✅ Done! Port $PORT is now free."

