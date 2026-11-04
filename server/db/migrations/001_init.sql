-- 001_init: relational schema replacing the single application document.
-- Times that the application compares numerically are stored as epoch milliseconds (bigint) to keep exact parity
-- with the previous data; human timestamps are ISO strings stored as timestamptz.

CREATE TABLE users (
  id              text PRIMARY KEY,
  email           text NOT NULL,
  name            text NOT NULL,
  phone           text NOT NULL DEFAULT '',
  password        text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  email_verified  boolean NOT NULL DEFAULT false,
  preferences     jsonb NOT NULL DEFAULT '{"product": true, "learning": true, "marketing": false}',
  profile         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE INDEX users_created_at_idx ON users (created_at DESC);
CREATE INDEX users_status_idx ON users (status);

CREATE TABLE entitlements (
  user_id          text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  language         text NOT NULL,
  plan             text NOT NULL CHECK (plan IN ('essential', 'plus')),
  expires_at       bigint NOT NULL,
  order_reference  text,
  source           text,
  granted_by       text,
  granted_at       timestamptz,
  PRIMARY KEY (user_id, language)
);
CREATE INDEX entitlements_expires_idx ON entitlements (expires_at);

CREATE TABLE sessions (
  id          text PRIMARY KEY,
  hash        text NOT NULL UNIQUE,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  bigint NOT NULL,
  last_seen   bigint NOT NULL,
  device      text NOT NULL DEFAULT 'Browser',
  expires     bigint NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires);

CREATE TABLE orders (
  reference                 text PRIMARY KEY,
  user_id                   text REFERENCES users (id) ON DELETE CASCADE,
  language                  text NOT NULL,
  plan                      text NOT NULL,
  term                      text NOT NULL CHECK (term IN ('monthly', 'yearly')),
  amount                    integer NOT NULL CHECK (amount >= 0),
  status                    text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  paid_at                   timestamptz,
  expires_at                bigint,
  paymob_order_id           text,
  intention_id              text,
  transaction_id            text,
  manual_payment_reference  text,
  activated_by              text,
  refunded_at               timestamptz,
  refunded_by               text
);
CREATE INDEX orders_user_idx ON orders (user_id);
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_created_idx ON orders (created_at DESC);
CREATE INDEX orders_paymob_idx ON orders (paymob_order_id) WHERE paymob_order_id IS NOT NULL;
CREATE UNIQUE INDEX orders_manual_ref_key ON orders (manual_payment_reference) WHERE manual_payment_reference IS NOT NULL;

CREATE TABLE support_tickets (
  reference   text PRIMARY KEY,
  user_id     text REFERENCES users (id) ON DELETE CASCADE,
  category    text NOT NULL,
  subject     text NOT NULL,
  message     text NOT NULL,
  status      text NOT NULL DEFAULT 'open',
  resolution  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX tickets_user_idx ON support_tickets (user_id);
CREATE INDEX tickets_status_idx ON support_tickets (status, created_at DESC);

CREATE TABLE security_tokens (
  hash        text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     text NOT NULL,
  expires     bigint NOT NULL,
  created_at  bigint NOT NULL
);
CREATE INDEX security_tokens_user_idx ON security_tokens (user_id, purpose);

CREATE TABLE leads (
  reference       text PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  name            text NOT NULL,
  email           text NOT NULL,
  phone           text NOT NULL,
  company         text NOT NULL DEFAULT '',
  kind            text NOT NULL,
  language        text NOT NULL,
  plan            text,
  term            text,
  group_size      integer,
  preferred_date  text,
  preferred_time  text,
  message         text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'new',
  updated_at      timestamptz,
  notes           jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX leads_status_idx ON leads (status, created_at DESC);

CREATE TABLE admins (
  id             text PRIMARY KEY,
  email          text NOT NULL,
  name           text NOT NULL,
  role           text NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  password       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text,
  last_login_at  timestamptz,
  mfa            jsonb
);
CREATE UNIQUE INDEX admins_email_key ON admins (lower(email));

CREATE TABLE admin_sessions (
  id          text PRIMARY KEY,
  hash        text NOT NULL UNIQUE,
  admin_id    text NOT NULL REFERENCES admins (id) ON DELETE CASCADE,
  stage       text NOT NULL DEFAULT 'full' CHECK (stage IN ('full', 'mfa')),
  attempts    integer NOT NULL DEFAULT 0,
  created_at  bigint NOT NULL,
  last_seen   bigint NOT NULL,
  expires     bigint NOT NULL,
  device      text
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);

-- Tamper-evident audit chain. Rows are append-only from the application's point of view.
CREATE TABLE audit_log (
  seq        bigint PRIMARY KEY,
  id         text NOT NULL,
  at         text NOT NULL,
  event      text NOT NULL,
  actor      jsonb,
  target     jsonb,
  meta       jsonb NOT NULL DEFAULT '{}',
  kid        text,
  prev_hash  text,
  hash       text,
  legacy     jsonb
);
CREATE INDEX audit_event_idx ON audit_log (event, seq DESC);
CREATE TABLE audit_chain (
  id           integer PRIMARY KEY CHECK (id = 1),
  seq          bigint NOT NULL,
  head         text NOT NULL,
  anchor_seq   bigint NOT NULL,
  anchor_hash  text NOT NULL
);
INSERT INTO audit_chain (id, seq, head, anchor_seq, anchor_hash) VALUES (1, 0, 'GENESIS', 0, 'GENESIS');

CREATE TABLE analytics_events (
  id       text PRIMARY KEY,
  name     text NOT NULL,
  user_id  text,
  path     text,
  meta     jsonb NOT NULL DEFAULT '{}',
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_at_idx ON analytics_events (at DESC);

CREATE TABLE meta (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);
