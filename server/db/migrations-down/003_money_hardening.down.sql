-- DOWN for 003_money_hardening. NOT run by the application (the migration runner only reads server/db/migrations/).
-- Run by hand, inside a transaction, after stopping the app and taking a snapshot:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f server/db/migrations-down/003_money_hardening.down.sql
-- Loses: every row of payment_events (provider payloads) and the orders.currency column. Back up payment_events first if
-- you need the audit trail (pg_dump --table=payment_events).
DROP TABLE IF EXISTS payment_events;
ALTER TABLE orders DROP COLUMN IF EXISTS currency;
DROP INDEX IF EXISTS orders_transaction_key;
DELETE FROM schema_migrations WHERE name = '003_money_hardening.sql';
