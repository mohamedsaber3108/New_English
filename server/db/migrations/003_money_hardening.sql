-- 003_money_hardening (E-6): additive and reversible. Down script: server/db/migrations-down/003_money_hardening.down.sql
-- (the runner never executes it). Before running on a real database: snapshot it, and run the dry-run query in
-- docs/DEPLOYMENT.md ("Migration 003") on a copy.

-- 1. Refuse to continue, with a clear message, if the unique index below would fail on existing data.
--    Nothing is changed: the whole migration runs in one transaction and rolls back.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM orders WHERE transaction_id IS NOT NULL GROUP BY transaction_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'migration 003 refused: duplicate orders.transaction_id values exist. Nothing was changed. Run the dry-run query in docs/DEPLOYMENT.md (Migration 003), resolve the duplicate rows by hand, then restart.';
  END IF;
END $$;

-- 2. One provider transaction id can belong to one order only (NULL = no payment attempt yet, any number allowed).
CREATE UNIQUE INDEX orders_transaction_key ON orders (transaction_id) WHERE transaction_id IS NOT NULL;

-- 3. Currency is stored with the order instead of being implied by code. Existing rows are EGP.
ALTER TABLE orders ADD COLUMN currency text NOT NULL DEFAULT 'EGP';

-- 4. Every verified provider event, stored once. event_id is the provider's own id for the event (for Paymob:
--    "<transaction id>:<state>", state = success | failed | pending | refunded | voided), so a replayed callback is a no-op
--    and a later state change of the same transaction (e.g. a refund) is still recorded.
--    raw_body holds the provider's JSON as received (it includes the customer's billing data: treat as personal data).
--    order_ref links an event to an order; rows are deleted with the learner's account (see DELETE /customer/account).
CREATE TABLE payment_events (
  id                  bigserial PRIMARY KEY,
  provider            text NOT NULL,
  event_id            text NOT NULL,
  order_ref           text,
  raw_body            text NOT NULL,
  signature_verified  boolean NOT NULL,
  -- What the application did with the event. Only 'applied' events are treated as replays (dropped); every other outcome
  -- is processed again when the provider retries (e.g. 'unmatched' becomes 'applied' once the order has its provider id).
  outcome             text NOT NULL DEFAULT 'applied' CHECK (outcome IN ('applied', 'rejected', 'unmatched', 'ignored')),
  received_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);
CREATE INDEX payment_events_order_idx ON payment_events (order_ref) WHERE order_ref IS NOT NULL;
CREATE INDEX payment_events_received_idx ON payment_events (received_at DESC);
