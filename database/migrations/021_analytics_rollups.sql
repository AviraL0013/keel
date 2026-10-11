-- Independent, bounded HyperSync rollups. No event payloads or transaction hashes are persisted.
CREATE TABLE IF NOT EXISTS analytics_rollup_coverage (
  from_block bigint NOT NULL CHECK (from_block >= 54773010),
  to_block bigint NOT NULL CHECK (to_block > from_block),
  from_time timestamptz NOT NULL,
  through_time timestamptz NOT NULL,
  end_hash text NOT NULL,
  log_count bigint NOT NULL CHECK (log_count >= 0),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_block, to_block)
);
CREATE INDEX IF NOT EXISTS analytics_rollup_coverage_to_idx ON analytics_rollup_coverage(to_block DESC);

CREATE TABLE IF NOT EXISTS analytics_rollup_bucket (
  from_block bigint NOT NULL,
  to_block bigint NOT NULL,
  grain text NOT NULL CHECK (grain IN ('hour', 'day')),
  bucket_start timestamptz NOT NULL,
  market_id integer NOT NULL, -- -1 is protocol total; nonnegative IDs are Perpl markets.
  fees_micros numeric(78,0) NOT NULL DEFAULT 0,
  revenue_micros numeric(78,0) NOT NULL DEFAULT 0,
  deposits_micros numeric(78,0) NOT NULL DEFAULT 0,
  withdrawals_micros numeric(78,0) NOT NULL DEFAULT 0,
  liquidation_count bigint NOT NULL DEFAULT 0,
  liquidation_notional_micros numeric(78,0) NOT NULL DEFAULT 0,
  long_opens bigint NOT NULL DEFAULT 0,
  short_opens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (from_block, to_block, grain, bucket_start, market_id),
  FOREIGN KEY (from_block, to_block) REFERENCES analytics_rollup_coverage(from_block, to_block) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS analytics_rollup_bucket_window_idx ON analytics_rollup_bucket(grain, bucket_start, market_id);

-- One row per account per UTC bucket and source block range. This is a distinct-user
-- rollup, not a fill ledger. Owner is filled only when proven by AccountCreated.
CREATE TABLE IF NOT EXISTS analytics_rollup_actor (
  from_block bigint NOT NULL,
  to_block bigint NOT NULL,
  grain text NOT NULL CHECK (grain IN ('hour', 'day')),
  bucket_start timestamptz NOT NULL,
  account_id numeric(78,0) NOT NULL,
  owner_address text,
  PRIMARY KEY (from_block, to_block, grain, bucket_start, account_id),
  FOREIGN KEY (from_block, to_block) REFERENCES analytics_rollup_coverage(from_block, to_block) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS analytics_rollup_actor_window_idx ON analytics_rollup_actor(grain, bucket_start);
CREATE INDEX IF NOT EXISTS analytics_rollup_actor_account_idx ON analytics_rollup_actor(account_id) WHERE owner_address IS NULL;
