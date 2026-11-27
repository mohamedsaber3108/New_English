-- Audit roles (A-1). Run ONCE by a database administrator at deploy time, after migration 005. Not part of any migration.
-- Replace :app_role / :retention_role with the real role names and set passwords outside this file.
--
-- Prerequisite: tables are owned by a migrator role (not by :app_role). The app connects as :app_role.
--
-- App role: may add audit entries and move the chain head, but cannot UPDATE or DELETE audit_log rows,
-- cannot touch audit_archive, and cannot move the retention anchor.
REVOKE ALL ON audit_log, audit_chain, audit_archive FROM :app_role;
GRANT SELECT, INSERT ON audit_log TO :app_role;
GRANT SELECT ON audit_chain TO :app_role;
GRANT UPDATE (seq, head) ON audit_chain TO :app_role;
-- Retention role: archives, deletes old rows and moves the anchor. Nothing else.
REVOKE ALL ON audit_log, audit_chain, audit_archive FROM :retention_role;
GRANT SELECT, DELETE ON audit_log TO :retention_role;
GRANT SELECT, INSERT ON audit_archive TO :retention_role;
GRANT SELECT ON audit_chain TO :retention_role;
GRANT UPDATE (anchor_seq, anchor_hash) ON audit_chain TO :retention_role;
GRANT SELECT ON schema_migrations TO :retention_role;
