/**
 * Migration 005: Fix Primary Account Trigger
 *
 * Fixes PostgreSQL error 21000 "ON CONFLICT DO UPDATE command cannot affect row a second time"
 *
 * The issue: When a user re-authenticates, the upsert operation conflicts with the trigger
 * that updates other accounts. The trigger was running even when is_primary wasn't changing,
 * causing unnecessary updates that violated PostgreSQL's constraint.
 *
 * The fix: Only run the trigger when is_primary is actually changing to true, and only
 * update rows that are currently set as primary.
 */

-- Drop and recreate the function with improved logic
CREATE OR REPLACE FUNCTION ensure_single_primary_account()
RETURNS TRIGGER AS $$
BEGIN
    -- Only update other accounts if:
    -- 1. NEW.is_primary is true (user is setting this account as primary)
    -- 2. AND either this is an INSERT or is_primary is changing from false to true
    IF NEW.is_primary = true AND (TG_OP = 'INSERT' OR OLD.is_primary = false OR OLD.is_primary IS NULL) THEN
        -- Set all other accounts for this user to non-primary
        -- Only update rows that are currently set as primary (avoid unnecessary updates)
        UPDATE connected_accounts
        SET is_primary = false,
            updated_at = NOW()
        WHERE user_id = NEW.user_id
        AND id != NEW.id
        AND is_primary = true;  -- Only update if currently primary
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate the trigger (ensures it uses the new function)
DROP TRIGGER IF EXISTS enforce_single_primary_account ON connected_accounts;
CREATE TRIGGER enforce_single_primary_account
    BEFORE INSERT OR UPDATE ON connected_accounts
    FOR EACH ROW
    EXECUTE FUNCTION ensure_single_primary_account();

-- Add a helpful comment
COMMENT ON FUNCTION ensure_single_primary_account() IS
'Ensures only one account per user can be marked as primary. Only updates when is_primary changes to true to avoid constraint violations during upsert operations.';
