-- Rollback for 005_admin_approvals. Run by hand (the app never runs down files).
-- WARNING: DROP TABLE audit_archive destroys archived audit rows. Export them first (see docs/ADMIN_OPERATIONS.md).
DROP TABLE IF EXISTS audit_archive;
DROP TABLE IF EXISTS admin_approvals;
ALTER TABLE admin_sessions DROP COLUMN IF EXISTS step_up_at;
DELETE FROM schema_migrations WHERE name = '005_admin_approvals.sql';
