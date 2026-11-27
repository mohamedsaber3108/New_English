-- Audit roles (A-1). Run ONCE by a database administrator at deploy time, after `npm run db:migrate`. Not part of any migration.
-- Replace :app_role / :retention_role with the real role names and set passwords outside this file.
-- Re-run it after any migration that adds tables (default privileges are not used on purpose).
--
-- Prerequisites
--  * Tables are owned by a migrator/owner role (not by :app_role or :retention_role). Migrations run as that owner:
--      DATABASE_URL=<owner url> npm run db:migrate
--  * The app and scripts/audit-retention.mjs connect as their own role with DB_SKIP_MIGRATIONS=1 (they cannot run DDL).
--
-- 1. App role: normal read/write on application tables ...
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :app_role;
-- ... except the audit tables: it may add audit entries and move the chain head, nothing else.
REVOKE ALL ON audit_log, audit_chain, audit_archive FROM :app_role;
GRANT SELECT, INSERT ON audit_log TO :app_role;
-- Account erasure clears the user id on pre-chain legacy rows. `legacy` is not part of any entry hash.
GRANT UPDATE (legacy) ON audit_log TO :app_role;
GRANT SELECT ON audit_chain TO :app_role;
GRANT UPDATE (seq, head) ON audit_chain TO :app_role;
-- Migrations are applied by the owner role; the app only reads the list.
REVOKE ALL ON schema_migrations FROM :app_role;
GRANT SELECT ON schema_migrations TO :app_role;
-- 2. Retention role: archives, deletes old rows and moves the anchor. Nothing else.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :retention_role;
GRANT SELECT, DELETE ON audit_log TO :retention_role;
GRANT SELECT, INSERT ON audit_archive TO :retention_role;
GRANT SELECT ON audit_chain TO :retention_role;
GRANT UPDATE (anchor_seq, anchor_hash) ON audit_chain TO :retention_role;
