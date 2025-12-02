"""
Configuration Module

Loads and validates environment variables
"""

import os
from dotenv import load_dotenv
from pydantic_settings import BaseSettings

# Load environment variables
load_dotenv()


class Settings(BaseSettings):
    """Application settings"""
    
    # Supabase
    SUPABASE_URL: str
    SUPABASE_SERVICE_ROLE_KEY: str
    
    # OpenAI
    OPENAI_API_KEY: str
    
    # Google OAuth
    GOOGLE_CLIENT_ID: str
    GOOGLE_CLIENT_SECRET: str
    
    # Deepgram
    DEEPGRAM_API_KEY: str
    
    # Parallel AI
    PARALLEL_API_KEY: str = ""
    
    # mem0.ai (optional - for long-term memory)
    MEM0_API_KEY: str = os.getenv('MEM0_API_KEY', '')
    
    # Session
    SESSION_SECRET: str = os.urandom(32).hex()
    
    # JWT (for service-to-service authentication)
    JWT_SECRET: str = os.getenv('JWT_SECRET', os.urandom(32).hex())
    
    # Server
    PORT: int = int(os.getenv('PORT', '8080'))
    NODE_ENV: str = os.getenv('NODE_ENV', 'development')
    
    # Logging
    LOG_LEVEL: str = os.getenv('LOG_LEVEL', 'info' if os.getenv('NODE_ENV') == 'production' else 'debug')
    
    class Config:
        env_file = '.env'
        case_sensitive = True


# Validate required environment variables
def validate_env():
    """Validate required environment variables"""
    required_vars = [
        'SUPABASE_URL',
        'SUPABASE_SERVICE_ROLE_KEY',
        'OPENAI_API_KEY',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'DEEPGRAM_API_KEY'
    ]
    
    missing = []
    for var in required_vars:
        if not os.getenv(var):
            missing.append(var)
    
    if missing:
        print('❌ Missing required environment variables:')
        for var in missing:
            print(f'   - {var}')
        print('\nPlease ensure your .env file contains all required variables.')
        return False
    
    return True


# Create settings instance
settings = Settings()

