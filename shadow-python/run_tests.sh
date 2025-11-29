#!/bin/bash
# Run tests using venv Python
cd "$(dirname "$0")"
./venv/bin/python -m pytest tests/ "$@"

