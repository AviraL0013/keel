-- Independent seven-day observations. Existing business state is not changed by migration.
CREATE TABLE IF NOT EXISTS reliability_runs (
  id uuid PRIMARY KEY,
  owner_user_id uuid REFERENCES users(id),
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','PAUSED')),
  next_restart_at timestamptz NOT NULL,
  next_chaos_at timestamptz NOT NULL,
  restarts_claimed integer NOT NULL DEFAULT 0 CHECK (restarts_claimed BETWEEN 0 AND 7),
  automation_paused boolean NOT NULL DEFAULT false,
  trading_states jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (ends_at > started_at)
);
CREATE TABLE IF NOT EXISTS reliability_samples (
  run_id uuid NOT NULL REFERENCES reliability_runs(id),
  slot_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  process_id uuid NOT NULL,
  healthy boolean NOT NULL,
  running boolean NOT NULL,
  lock_owned boolean NOT NULL,
  venue_ready boolean NOT NULL,
  tick_age_ms bigint CHECK (tick_age_ms >= 0),
  PRIMARY KEY (run_id,slot_at)
);
CREATE TABLE IF NOT EXISTS reliability_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES reliability_runs(id),
  kind text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('mainnet','sandbox')),
  process_id uuid NOT NULL,
  observed_at timestamptz NOT NULL,
  restart_index integer CHECK (restart_index BETWEEN 1 AND 7),
  clean boolean,
  UNIQUE(run_id,kind,process_id,observed_at)
);
CREATE INDEX IF NOT EXISTS reliability_events_time ON reliability_events(run_id,observed_at);
CREATE TABLE IF NOT EXISTS reliability_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES reliability_runs(id),
  incident_key text NOT NULL,
  kind text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('mainnet','sandbox')),
  detected_at timestamptz NOT NULL,
  recovered_at timestamptz,
  status text NOT NULL CHECK (status IN ('OPEN','RECOVERED')),
  summary text NOT NULL
);
ALTER TABLE reliability_incidents ADD COLUMN IF NOT EXISTS source_event_id uuid;
ALTER TABLE reliability_incidents DROP CONSTRAINT IF EXISTS reliability_incidents_run_id_incident_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS reliability_incidents_open_key
  ON reliability_incidents(run_id,incident_key) WHERE status='OPEN';
CREATE INDEX IF NOT EXISTS reliability_incidents_open ON reliability_incidents(run_id,detected_at) WHERE status='OPEN';
CREATE INDEX IF NOT EXISTS reliability_incidents_page ON reliability_incidents(run_id,detected_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS reliability_incidents_source_event
  ON reliability_incidents(run_id,source_event_id) WHERE source_event_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS reliability_chaos (
  run_id uuid NOT NULL REFERENCES reliability_runs(id),
  batch_at timestamptz NOT NULL,
  scenario text NOT NULL,
  injected_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('passed','failed','unavailable')),
  recovery_ms numeric NOT NULL CHECK (recovery_ms >= 0),
  no_duplicate_orders boolean NOT NULL,
  no_unknown_resubmission boolean NOT NULL,
  no_partial_resubmission boolean NOT NULL,
  fail_closed boolean NOT NULL,
  PRIMARY KEY (run_id,batch_at,scenario)
);
CREATE TABLE IF NOT EXISTS reliability_book_sends (
  run_id uuid NOT NULL REFERENCES reliability_runs(id),
  action_id uuid NOT NULL REFERENCES actions(id),
  attempted_at timestamptz NOT NULL,
  PRIMARY KEY (run_id,action_id)
);
