/**
 * Supabase Database Connection
 *
 * Manages Supabase client for all database operations
 * Supabase uses PostgreSQL under the hood, so all our SQL queries still work!
 */

// Load environment variables first (before creating client)
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

// Validate required environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file');
    console.error('Please ensure your .env file contains both variables.');
    process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY, // Use service role key for server-side operations
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);

/**
 * Table references for Supabase-style queries (optional convenience)
 */
const db = {
    users: supabase.from('users'),
    connected_accounts: supabase.from('connected_accounts'),
    sessions: supabase.from('sessions')
};

/**
 * Test database connection
 * @returns {Promise<boolean>} - Connection status
 */
async function testConnection() {
    try {
        // First, verify we can reach Supabase at all
        const url = process.env.SUPABASE_URL;
        if (!url || !url.includes('supabase.co')) {
            console.error('❌ Invalid SUPABASE_URL format');
            return false;
        }

        // Try a simple query - use limit(0) to avoid fetching data, just test connection
        const { data, error } = await supabase.from('users').select('*').limit(0);

        if (error && error.code === '42P01') {
            // Table doesn't exist yet - this is fine during initial setup
            console.log('⚠️  Tables not created yet. Run migrations first.');
            console.log('   Run: node db/runMigrations.js');
            return true; // Return true so server can start, migrations can be run later
        }

        if (error) {
            // Log more details about the error
            console.error('❌ Supabase error details:', {
                message: error.message,
                code: error.code,
                details: error.details,
                hint: error.hint
            });
            
            // If it's an internal server error, it might be a connection/auth issue
            if (error.message.includes('Internal server error')) {
                console.error('\n💡 Troubleshooting "Internal server error":');
                console.error('1. Verify SUPABASE_URL is correct:', url);
                console.error('2. Check SUPABASE_SERVICE_ROLE_KEY is valid (not expired)');
                console.error('3. Go to Supabase Dashboard → Settings → API → verify service_role key');
                console.error('4. Check Supabase project status at https://supabase.com/dashboard');
                console.error('5. Try regenerating service_role key if needed');
                console.error('\n⚠️  Server will continue but database features may not work.');
                // Don't throw - allow server to start but warn user
                return false;
            }
            
            throw error;
        }

        console.log('✅ Supabase connected successfully');
        return true;
    } catch (error) {
        console.error('❌ Supabase connection failed:', error.message);
        console.error('\n⚠️  Server will continue but database features may not work.');
        return false; // Return false but don't exit - let server start anyway
    }
}

/**
 * Close connection (not needed for Supabase, but included for compatibility)
 */
async function closePool() {
    console.log('Supabase connection cleanup (no-op)');
}

/**
 * Get a client (for compatibility with transaction code)
 * Note: Supabase handles transactions differently
 */
async function getClient() {
    return supabase;
}

module.exports = {
    getClient,
    testConnection,
    closePool,
    supabase,
    db // Export table references for Supabase-style queries
};
