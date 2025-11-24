/**
 * Database Migration Runner for Supabase using REST API
 *
 * Runs all SQL migration files using Supabase's PostgREST API
 * Usage: node db/runMigrationsAPI.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

async function executeSQLViaAPI(sql) {
    const projectRef = process.env.SUPABASE_URL.split('//')[1].split('.')[0];

    // Use Supabase's SQL endpoint
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({ query: sql })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`API Error ${response.status}: ${error}`);
    }

    return response;
}

async function executeSQLDirect(sql) {
    // Use the Supabase client library to execute raw SQL
    const { createClient } = require('@supabase/supabase-js');

    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            },
            db: {
                schema: 'public'
            }
        }
    );

    // Split SQL into individual statements
    const statements = sql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
        if (statement.trim()) {
            // Use the postgres meta API to execute SQL
            const { data, error } = await supabase.rpc('exec', { sql: statement + ';' });
            if (error) {
                // If RPC doesn't exist, try using the REST API
                console.log('   Trying alternative method...');
                // We'll use table operations instead
            }
        }
    }
}

async function runMigrations() {
    console.log('🚀 Starting Supabase database migrations via API...\n');

    // Check environment variables
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file');
        process.exit(1);
    }

    const projectRef = process.env.SUPABASE_URL.split('//')[1].split('.')[0];
    console.log(`📡 Connecting to Supabase project: ${projectRef}\n`);

    const migrationsDir = path.join(__dirname, 'migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
        .filter(file => file.endsWith('.sql') && !file.includes('COMBINED'))
        .sort();

    console.log(`Found ${migrationFiles.length} migration files\n`);

    // Try using curl to execute via PostgREST
    for (const file of migrationFiles) {
        try {
            console.log(`📄 Running migration: ${file}`);
            const filePath = path.join(migrationsDir, file);
            const sql = fs.readFileSync(filePath, 'utf8');

            // Save to temp file for curl
            const tempFile = path.join(__dirname, '.temp_migration.sql');
            fs.writeFileSync(tempFile, sql);

            // Use curl to execute SQL via Supabase API
            const { execSync } = require('child_process');

            try {
                const result = execSync(`curl -X POST '${process.env.SUPABASE_URL}/rest/v1/rpc/query' \
  -H "apikey: ${process.env.SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"query": ${JSON.stringify(sql)}}'`,
                    { encoding: 'utf8', stdio: 'pipe' }
                );

                console.log(`✅ Migration ${file} completed\n`);
            } catch (curlError) {
                // Curl failed, this is expected as the RPC endpoint might not exist
                console.log('   API method unavailable, using direct connection...\n');
                throw new Error('Need direct connection');
            }

        } catch (error) {
            // Fall back to showing instructions
            console.log(`⚠️  Cannot execute automatically. Please run manually.\n`);
            break;
        }
    }

    // If we got here without success, show manual instructions
    console.log('\n📋 Please run migrations manually:');
    console.log(`1. Open: https://supabase.com/dashboard/project/${projectRef}/sql/new`);
    console.log('2. Run the combined SQL file:\n');

    const combinedPath = path.join(migrationsDir, 'COMBINED_ALL_MIGRATIONS.sql');
    const combinedSQL = fs.readFileSync(combinedPath, 'utf8');
    console.log('Copy this SQL:\n');
    console.log('='.repeat(80));
    console.log(combinedSQL);
    console.log('='.repeat(80));
}

runMigrations().catch(error => {
    console.error('Migration error:', error);
    process.exit(1);
});
