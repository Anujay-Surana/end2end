# Environment Variables Setup

This document lists all required and optional environment variables for the HumanMax backend.

## Required Environment Variables

Add these to your `.env` file:

```bash
# Database (Supabase)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# OpenAI API
OPENAI_API_KEY=sk-your-openai-api-key

# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret

# Deepgram API (Speech-to-Text)
DEEPGRAM_API_KEY=your-deepgram-api-key
```

## Optional Environment Variables

```bash
# Parallel AI API (Optional - for web search features)
PARALLEL_API_KEY=your-parallel-api-key

# JWT Secret (for service-to-service authentication)
# Generate a secure random string: openssl rand -hex 32
# If not set, a random value will be generated (not recommended for production)
JWT_SECRET=your-jwt-secret-key-change-this-in-production

# Server Configuration
PORT=3000
NODE_ENV=development
LOG_LEVEL=debug

# CORS Configuration
ALLOWED_ORIGINS=*
# Or specify specific origins: ALLOWED_ORIGINS=http://localhost:3000,https://yourdomain.com

# Railway Deployment (Optional)
ROOT_PATH=
```

## Quick Setup

1. Copy the required variables above to your `.env` file
2. Fill in your actual values
3. For `JWT_SECRET`, generate a secure random string:
   ```bash
   openssl rand -hex 32
   ```

## New Variables Added for Authentication Architecture

The following variables were added for the new authentication architecture:

- **JWT_SECRET**: Required for service-to-service authentication using JWT tokens. Generate a secure random string and set it in your `.env` file.

All other variables remain the same as before.

