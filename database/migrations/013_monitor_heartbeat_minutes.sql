CREATE TABLE IF NOT EXISTS monitor_heartbeat_minutes (
  minute timestamptz PRIMARY KEY,
  first_tick timestamptz NOT NULL,
  last_tick timestamptz NOT NULL,
  tick_count integer NOT NULL CHECK (tick_count > 0)
);
