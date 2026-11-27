-- 004_ai_usage (E-8): per learner, per Cairo day, per route (coach | simulation): how many live-AI calls, how many tokens,
-- and the estimated cost. Numbers only: NO message text, no prompts, no replies are stored here.
-- Additive and reversible (server/db/migrations-down/004_ai_usage.down.sql, never run by the application).
-- Depends only on the users table from 001; it does not depend on migration 003 (money hardening).
-- est_cost_micro_usd is in millionths of a US dollar (1,000,000 = USD 1); it is 0 until AI_PRICE_IN_PER_1K_MICRO and
-- AI_PRICE_OUT_PER_1K_MICRO are set, so an estimate is never invented.
CREATE TABLE ai_usage (
  user_id             text    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day                 text    NOT NULL,                       -- learner calendar day (Africa/Cairo), YYYY-MM-DD
  route               text    NOT NULL,                       -- coach | simulation
  calls               integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  tokens_in           bigint  NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out          bigint  NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  est_cost_micro_usd  bigint  NOT NULL DEFAULT 0 CHECK (est_cost_micro_usd >= 0),
  PRIMARY KEY (user_id, day, route)
);
CREATE INDEX ai_usage_day_idx ON ai_usage (day);
