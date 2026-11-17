-- 002_learning: server-side learning records. Progress shown to the learner is computed from these rows,
-- not trusted from the browser.

-- Set once the learner's legacy browser-synced progress blob (users.profile.sessions/reviews/xp) has been converted.
ALTER TABLE users ADD COLUMN learning_imported boolean NOT NULL DEFAULT false;

-- One row per completed learning activity (simulation, coach conversation, story, writing, pronunciation, ...).
CREATE TABLE learning_activities (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id   text,                       -- idempotency key from the client (retries never double-count)
  kind        text NOT NULL,              -- simulation | coach | story | writing | pronunciation | legacy
  ref         text,                       -- scenario id / activity id shown in the UI
  title       text NOT NULL,
  skill       text NOT NULL,              -- skill this activity is evidence for
  words       jsonb NOT NULL DEFAULT '[]',
  summary     text NOT NULL DEFAULT '',
  metrics     jsonb NOT NULL DEFAULT '{}',
  xp          integer NOT NULL DEFAULT 0 CHECK (xp >= 0),
  day         text NOT NULL,              -- learner calendar day (Africa/Cairo), YYYY-MM-DD: streaks + daily caps
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX learning_activities_client_key ON learning_activities (user_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX learning_activities_user_time_idx ON learning_activities (user_id, created_at DESC);
CREATE INDEX learning_activities_user_day_idx ON learning_activities (user_id, day);

-- Spaced-repetition cards (SM-2 state, see server/scheduler.js).
CREATE TABLE review_cards (
  user_id        text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  word           text NOT NULL,
  reps           integer NOT NULL DEFAULT 0,
  interval_days  integer NOT NULL DEFAULT 0,
  ease           double precision NOT NULL DEFAULT 2.5,
  due            bigint NOT NULL,
  lapses         integer NOT NULL DEFAULT 0,
  last_reviewed  bigint,
  created_at     bigint NOT NULL,
  PRIMARY KEY (user_id, word)
);
CREATE INDEX review_cards_due_idx ON review_cards (user_id, due);

-- Placement / diagnostic assessments (history; latest result drives the displayed level and skill estimates).
CREATE TABLE assessments (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'placement',
  answers     jsonb NOT NULL DEFAULT '{}',
  result      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assessments_user_time_idx ON assessments (user_id, created_at DESC);
