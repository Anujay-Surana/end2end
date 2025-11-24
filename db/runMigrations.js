/**
 * Database Migration Runner for Supabase
 *
 * Runs all SQL migration files in order using direct PostgreSQL connection
 * Usage: node db/runMigrations.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function runMigrations() {
    console.log('🚀 Starting Supabase database migrations...\n');

    // Check environment variables
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env file');
        process.exit(1);
    }

    // Extract project ref from Supabase URL (e.g., gtxxpbzieigpsbygcenv from https://gtxxpbzieigpsbygcenv.supabase.co)
    const projectRef = process.env.SUPABASE_URL.split('//')[1].split('.')[0];

    console.log(`📡 Connecting to Supabase project: ${projectRef}\n`);
    console.log('⚠️  Note: Direct PostgreSQL connection requires database password.');
    console.log('   If this fails, you can run migrations manually in Supabase SQL Editor:');
    console.log(`   https://supabase.com/dashboard/project/${projectRef}/sql/new\n`);

    // For Supabase, we'll need to use the connection pooler
    // Format: postgresql://postgres.[project-ref]:[password]@aws-0-us-west-1.pooler.supabase.com:6543/postgres

    console.log('📝 Migration files will be displayed below.');
    console.log('   Please copy and run them manually in Supabase SQL Editor.\n');
    console.log('=' .repeat(80));

    const migrationsDir = path.join(__dirname, 'migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
        .filter(file => file.endsWith('.sql'))
        .sort(); // Run in alphabetical order (001, 002, 003...)

    console.log(`\nFound ${migrationFiles.length} migration files:\n`);

    for (const file of migrationFiles) {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`📄 Migration: ${file}`);
        console.log('='.repeat(80));
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf8');
        console.log(sql);
        console.log('='.repeat(80));
    }

    console.log('\n\n📋 INSTRUCTIONS:');
    console.log('1. Open Supabase SQL Editor:');
    console.log(`   https://supabase.com/dashboard/project/${projectRef}/sql/new`);
    console.log('2. Copy each migration above and run it in order');
    console.log('3. Verify tables are created successfully\n');
}

// Run migrations
runMigrations().catch(error => {
    console.error('Migration error:', error);
    process.exit(1);
});
