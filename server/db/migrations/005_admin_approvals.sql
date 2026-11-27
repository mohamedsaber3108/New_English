-- 005_admin_approvals (A-1): step-up timestamp on admin sessions, second-approver requests, audit archive.
-- Additive only. No database roles are created here (that is a deploy step, see docs/ADMIN_OPERATIONS.md).

ALTER TABLE admin_sessions ADD COLUMN step_up_at bigint;

CREATE TABLE admin_approvals (
  id               text PRIMARY KEY,
  kind             text NOT NULL CHECK (kind IN ('refund', 'admin_update')),
  target           text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}',
  reason           text NOT NULL,
  requested_by     text NOT NULL,
  requested_at     bigint NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  decided_by       text,
  decided_at       bigint,
  decision_reason  text
);
-- One open request per kind and target.
CREATE UNIQUE INDEX admin_approvals_open_key ON admin_approvals (kind, target) WHERE status = 'pending';
CREATE INDEX admin_approvals_status_idx ON admin_approvals (status, requested_at DESC);

-- Rows removed from audit_log by retention are copied here first. The chain anchor in audit_chain moves with them.
CREATE TABLE audit_archive (LIKE audit_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES, archived_at timestamptz NOT NULL DEFAULT now());
