-- Hourly observations only. These are stock values, never sums of events.
CREATE TABLE IF NOT EXISTS analytics_protocol_snapshots (
  metric text NOT NULL CHECK (metric IN ('oi', 'tvl')),
  bucket_start timestamptz NOT NULL,
  value_micros numeric(78,0) NOT NULL CHECK (value_micros >= 0),
  observed_at timestamptz NOT NULL,
  block_number bigint CHECK (block_number > 0),
  PRIMARY KEY (metric, bucket_start)
);

CREATE INDEX IF NOT EXISTS analytics_protocol_snapshots_latest_idx
  ON analytics_protocol_snapshots(metric, bucket_start DESC);
