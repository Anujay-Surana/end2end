"""
Supabase Database Connection

Manages Supabase client for all database operations
Supabase uses PostgreSQL under the hood, so all our SQL queries still work!
"""

import os
from dotenv import load_dotenv
from supabase import create_client, Client

# Load environment variables first (before creating client)
load_dotenv()

# Validate required environment variables
if not os.getenv('SUPABASE_URL') or not os.getenv('SUPABASE_SERVICE_ROLE_KEY'):
    print('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file')
    print('Please ensure your .env file contains both variables.')
    exit(1)

# Initialize Supabase client
# Note: options parameter should be omitted or passed as None if not using ClientOptions
supabase: Client = create_client(
    os.getenv('SUPABASE_URL'),
    os.getenv('SUPABASE_SERVICE_ROLE_KEY')  # Use service role key for server-side operations
)

"""
Table references for Supabase-style queries (optional convenience)
"""
db = {
    'users': supabase.table('users'),
    'connected_accounts': supabase.table('connected_accounts'),
    'sessions': supabase.table('sessions')
}


async def test_connection() -> bool:
    """
    Test database connection
    Returns: Connection status
    """
    try:
        # First, verify we can reach Supabase at all
        url = os.getenv('SUPABASE_URL')
        if not url or 'supabase.co' not in url:
            print('❌ Invalid SUPABASE_URL format')
            return False

        # Try a simple query - use limit(0) to avoid fetching data, just test connection
        response = supabase.table('users').select('*').limit(0).execute()
        
        # Check for error in response
        if hasattr(response, 'error') and response.error:
            error = response.error
            if error.code == '42P01':
                # Table doesn't exist yet - this is fine during initial setup
                print('⚠️  Tables not created yet. Run migrations first.')
                print('   Run: node db/runMigrations.js')
                return True  # Return true so server can start, migrations can be run later
            
            # Log more details about the error
            print('❌ Supabase error details:', {
                'message': error.message,
                'code': getattr(error, 'code', None),
                'details': getattr(error, 'details', None),
                'hint': getattr(error, 'hint', None)
            })
            
            # If it's an internal server error, it might be a connection/auth issue
            if 'Internal server error' in error.message:
                print('\n💡 Troubleshooting "Internal server error":')
                print(f'1. Verify SUPABASE_URL is correct: {url}')
                print('2. Check SUPABASE_SERVICE_ROLE_KEY is valid (not expired)')
                print('3. Go to Supabase Dashboard → Settings → API → verify service_role key')
                print('4. Check Supabase project status at https://supabase.com/dashboard')
                print('5. Try regenerating service_role key if needed')
                print('\n⚠️  Server will continue but database features may not work.')
                return False
            
            raise error

        print('✅ Supabase connected successfully')
        return True
    except Exception as error:
        error_msg = str(error)
        print(f'❌ Supabase connection failed: {error_msg}')
        print('\n⚠️  Server will continue but database features may not work.')
        
        # If it's an internal server error, it might be a connection/auth issue
        if 'Internal server error' in error_msg:
            print('\n💡 Troubleshooting "Internal server error":')
            print(f'1. Verify SUPABASE_URL is correct: {url}')
            print('2. Check SUPABASE_SERVICE_ROLE_KEY is valid (not expired)')
            print('3. Go to Supabase Dashboard → Settings → API → verify service_role key')
            print('4. Check Supabase project status at https://supabase.com/dashboard')
            print('5. Try regenerating service_role key if needed')
            print('\n⚠️  Server will continue but database features may not work.')
        
        return False  # Return false but don't exit - let server start anyway


async def close_pool():
    """
    Close connection (not needed for Supabase, but included for compatibility)
    """
    print('Supabase connection cleanup (no-op)')


async def get_client() -> Client:
    """
    Get a client (for compatibility with transaction code)
    Note: Supabase handles transactions differently
    """
    return supabase

