-- Compact, rolling position ledger. Existing rollups remain readable during backfill.
ALTER TABLE analytics_rollup_coverage ADD COLUMN IF NOT EXISTS wallet_indexed_at timestamptz;

CREATE TABLE IF NOT EXISTS analytics_wallet_event (
  from_block bigint NOT NULL,
  to_block bigint NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  transaction_hash text NOT NULL,
  transaction_index integer NOT NULL,
  log_index integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  account_id numeric(78,0) NOT NULL,
  market_id integer NOT NULL,
  side text CHECK (side IN ('long','short')),
  action text NOT NULL,
  price_raw numeric(78,0),
  size_raw numeric(78,0),
  fee_micros numeric(78,0),
  realized_pnl_micros numeric(78,0),
  fill_verified boolean NOT NULL DEFAULT false,
  PRIMARY KEY (block_number,transaction_hash,log_index),
  FOREIGN KEY (from_block,to_block) REFERENCES analytics_rollup_coverage(from_block,to_block) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS analytics_wallet_event_account_time_idx
  ON analytics_wallet_event(account_id,occurred_at DESC,block_number DESC,log_index DESC);
CREATE INDEX IF NOT EXISTS analytics_rollup_wallet_missing_idx
  ON analytics_rollup_coverage(from_block DESC) WHERE wallet_indexed_at IS NULL;
