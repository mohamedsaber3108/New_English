-- DOWN for 004_ai_usage. NOT run by the application (the migration runner only reads server/db/migrations/).
-- Run by hand after stopping the app and taking a snapshot:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f server/db/migrations-down/004_ai_usage.down.sql
-- Loses all stored AI usage numbers (back up first if you need them: pg_dump --table=ai_usage).
DROP TABLE IF EXISTS ai_usage;
DELETE FROM schema_migrations WHERE name = '004_ai_usage.sql';
