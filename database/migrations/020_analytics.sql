-- Independent read-only chain index; never shares trading worker ownership.
CREATE TABLE IF NOT EXISTS analytics_checkpoint (
  chain_id integer PRIMARY KEY CHECK (chain_id = 143),
  start_block bigint NOT NULL CHECK (start_block >= 0),
  next_block bigint NOT NULL CHECK (next_block >= start_block),
  history_verified boolean NOT NULL DEFAULT false,
  last_block_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS analytics_blocks (
  block_number bigint PRIMARY KEY,
  block_hash text NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS analytics_raw_events (
  block_number bigint NOT NULL REFERENCES analytics_blocks(block_number) ON DELETE CASCADE,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  transaction_index integer NOT NULL,
  block_hash text NOT NULL,
  event_name text,
  args jsonb,
  data text NOT NULL,
  topics jsonb NOT NULL,
  PRIMARY KEY (block_number, transaction_hash, log_index)
);
CREATE INDEX IF NOT EXISTS analytics_raw_events_name_block_idx ON analytics_raw_events(event_name, block_number DESC);
CREATE TABLE IF NOT EXISTS analytics_accounts (
  account_id numeric(78,0) PRIMARY KEY,
  address text NOT NULL,
  created_block bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS analytics_accounts_address_idx ON analytics_accounts(address);
CREATE TABLE IF NOT EXISTS analytics_flows (
  block_number bigint NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  account_id numeric(78,0) NOT NULL,
  direction text NOT NULL CHECK (direction IN ('deposit','withdrawal')),
  amount_micros numeric(78,0) NOT NULL CHECK(amount_micros >= 0),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (block_number, transaction_hash, log_index),
  FOREIGN KEY (block_number, transaction_hash, log_index)
    REFERENCES analytics_raw_events(block_number, transaction_hash, log_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS analytics_flows_time_idx ON analytics_flows(occurred_at DESC);
CREATE TABLE IF NOT EXISTS analytics_fills (
  block_number bigint NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  account_id numeric(78,0) NOT NULL,
  market_id integer NOT NULL,
  price_raw numeric(78,0) NOT NULL,
  size_raw numeric(78,0) NOT NULL,
  notional_micros numeric(78,0) NOT NULL,
  fee_micros numeric(78,0) NOT NULL,
  builder_fee_micros numeric(78,0) NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (block_number, transaction_hash, log_index),
  FOREIGN KEY (block_number, transaction_hash, log_index)
    REFERENCES analytics_raw_events(block_number, transaction_hash, log_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS analytics_fills_time_idx ON analytics_fills(occurred_at DESC);
CREATE INDEX IF NOT EXISTS analytics_fills_account_time_idx ON analytics_fills(account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS analytics_fills_market_time_idx ON analytics_fills(market_id, occurred_at DESC);
CREATE TABLE IF NOT EXISTS analytics_taker_fees (
  block_number bigint NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  fee_micros numeric(78,0) NOT NULL,
  builder_fee_micros numeric(78,0) NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (block_number, transaction_hash, log_index),
  FOREIGN KEY (block_number, transaction_hash, log_index)
    REFERENCES analytics_raw_events(block_number, transaction_hash, log_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS analytics_taker_fees_time_idx ON analytics_taker_fees(occurred_at DESC);
CREATE TABLE IF NOT EXISTS analytics_liquidations (
  block_number bigint NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  account_id numeric(78,0) NOT NULL,
  market_id integer NOT NULL,
  side text NOT NULL CHECK(side IN ('long','short')),
  lot_raw numeric(78,0) NOT NULL,
  price_raw numeric(78,0) NOT NULL,
  notional_micros numeric(78,0) NOT NULL,
  realized_pnl_micros numeric(78,0) NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (block_number, transaction_hash, log_index),
  FOREIGN KEY (block_number, transaction_hash, log_index)
    REFERENCES analytics_raw_events(block_number, transaction_hash, log_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS analytics_liquidations_time_idx ON analytics_liquidations(occurred_at DESC, block_number DESC, log_index DESC);
CREATE TABLE IF NOT EXISTS analytics_position_events (
  block_number bigint NOT NULL,
  transaction_hash text NOT NULL,
  log_index integer NOT NULL,
  account_id numeric(78,0) NOT NULL,
  market_id integer NOT NULL,
  side text NOT NULL CHECK(side IN ('long','short')),
  action text NOT NULL CHECK(action IN ('open','increase','reduce','close','liquidation','invert')),
  size_raw numeric(78,0),
  entry_price_raw numeric(78,0),
  leverage_hundredths numeric(78,0),
  collateral_micros numeric(78,0),
  realized_pnl_micros numeric(78,0),
  protocol_fee_micros numeric(78,0),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (block_number, transaction_hash, log_index),
  FOREIGN KEY (block_number, transaction_hash, log_index)
    REFERENCES analytics_raw_events(block_number, transaction_hash, log_index) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS analytics_position_events_account_idx ON analytics_position_events(account_id, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS analytics_position_events_market_latest_idx ON analytics_position_events(market_id,account_id,block_number DESC,log_index DESC);
CREATE TABLE IF NOT EXISTS analytics_market_hourly (
  hour timestamptz NOT NULL,
  market_id integer NOT NULL,
  volume_micros numeric(78,0) NOT NULL DEFAULT 0,
  maker_fees_micros numeric(78,0) NOT NULL DEFAULT 0,
  active_accounts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, market_id)
);
CREATE TABLE IF NOT EXISTS analytics_market_daily (
  day date NOT NULL,
  market_id integer NOT NULL,
  volume_micros numeric(78,0) NOT NULL DEFAULT 0,
  maker_fees_micros numeric(78,0) NOT NULL DEFAULT 0,
  active_accounts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, market_id)
);
