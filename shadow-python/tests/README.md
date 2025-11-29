# Testing Guide

## Running Tests

```bash
# Activate virtual environment
source venv/bin/activate

# Run all tests
pytest

# Run with verbose output
pytest -v

# Run specific test file
pytest tests/test_routes/test_auth.py

# Run with coverage
pytest --cov=app --cov-report=html

# Run tests matching pattern
pytest -k "test_auth"
```

## Test Structure

```
tests/
├── conftest.py          # Test fixtures and configuration
├── test_routes/         # Route endpoint tests
│   ├── test_auth.py     # Authentication routes
│   ├── test_accounts.py # Account management
│   ├── test_meetings.py # Meeting preparation
│   └── test_day_prep.py # Day prep routes
├── test_services/       # Service layer tests
│   └── test_oauth.py    # OAuth services
└── test_db/            # Database query tests
    └── test_queries.py # Database operations
```

## Writing Tests

### Basic Test Example

```python
def test_endpoint(client):
    """Test an endpoint"""
    response = client.get('/health')
    assert response.status_code == 200
    assert response.json() == {'status': 'ok'}
```

### Testing with Authentication

```python
def test_protected_endpoint(client, mock_user):
    """Test protected endpoint"""
    # Mock authentication
    with patch('app.middleware.auth.require_auth', return_value=mock_user):
        response = client.get('/api/accounts')
        assert response.status_code == 200
```

## Test Fixtures

Available fixtures (defined in `conftest.py`):
- `client` - FastAPI test client
- `mock_user` - Mock user data
- `mock_account` - Mock account data
- `mock_session` - Mock session data
- `mock_openai_response` - Mock OpenAI API response
- `mock_google_profile` - Mock Google user profile
- `mock_oauth_tokens` - Mock OAuth tokens

## Notes

- Tests use mocked external dependencies (database, APIs) to avoid requiring real credentials
- Environment variables are set to test values in `conftest.py`
- Database operations are mocked to avoid requiring a real database connection

