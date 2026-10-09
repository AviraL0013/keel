-- Strategy capital is an explicit allocation. It is never a Book reserve credit.
CREATE TABLE IF NOT EXISTS strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  connection_id uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('testnet','mainnet')),
  account_id bigint NOT NULL CHECK(account_id > 0),
  market_id integer NOT NULL CHECK(market_id > 0),
  mode text NOT NULL CHECK(mode IN ('BACKTEST','PAPER','LIVE')),
  kind text NOT NULL CHECK(kind IN ('GRID','MARKET_MAKER')),
  capital numeric(40,6) NOT NULL CHECK(capital > 0),
  config jsonb NOT NULL,
  state jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK(status IN ('PAUSED','RUNNING','HALTED','STOPPED')),
  live_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(connection_id,user_id) REFERENCES perpl_connections(id,user_id),
  UNIQUE(id,environment,account_id,market_id)
);
CREATE INDEX IF NOT EXISTS strategies_user_status_idx ON strategies(user_id,status);

CREATE TABLE IF NOT EXISTS strategy_user_controls (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  killed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid NOT NULL,
  environment text NOT NULL,
  account_id bigint NOT NULL,
  market_id integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('POST','CHANGE','CANCEL')),
  simulated boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK(status IN ('QUEUED','SUBMITTING','OPEN','PARTIAL','FILLED','CANCELED','EXPIRED','FAILED','UNKNOWN')),
  side text CHECK(side IN ('BUY','SELL')),
  price numeric(40,18),
  size numeric(40,18),
  filled_size numeric(40,18) NOT NULL DEFAULT 0,
  venue_order_id bigint,
  request_id numeric(20,0),
  last_execution_block bigint,
  venue_progress jsonb,
  transaction_hash text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(strategy_id,environment,account_id,market_id)
    REFERENCES strategies(id,environment,account_id,market_id),
  CHECK(kind <> 'POST' OR (side IS NOT NULL AND price > 0 AND size > 0)),
  CHECK(request_id IS NULL OR request_id > 0),
  CHECK(last_execution_block IS NULL OR last_execution_block > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_orders_request_idx
  ON strategy_orders(environment,account_id,request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS strategy_orders_open_idx ON strategy_orders(strategy_id,status,created_at);

CREATE TABLE IF NOT EXISTS strategy_fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  order_id uuid NOT NULL REFERENCES strategy_orders(id),
  venue_order_id bigint,
  transaction_hash text,
  block_number bigint,
  transaction_index integer,
  log_index integer,
  simulated boolean NOT NULL DEFAULT false,
  side text NOT NULL CHECK(side IN ('BUY','SELL')),
  liquidity text NOT NULL CHECK(liquidity IN ('MAKER','TAKER')),
  price numeric(40,18) NOT NULL CHECK(price > 0),
  size numeric(40,18) NOT NULL CHECK(size > 0),
  fee numeric(40,18) NOT NULL,
  filled_at timestamptz NOT NULL,
  UNIQUE(strategy_id,block_number,transaction_index,log_index),
  CHECK(simulated OR (venue_order_id IS NOT NULL AND block_number IS NOT NULL AND
    transaction_index IS NOT NULL AND log_index IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS strategy_fills_time_idx ON strategy_fills(strategy_id,filled_at);

CREATE TABLE IF NOT EXISTS strategy_risk_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  code text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategy_risk_events_time_idx ON strategy_risk_events(strategy_id,observed_at);

CREATE TABLE IF NOT EXISTS strategy_equity_points (
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  observed_at timestamptz NOT NULL,
  equity numeric(40,18) NOT NULL,
  inventory numeric(40,18) NOT NULL,
  PRIMARY KEY(strategy_id,observed_at)
);

CREATE TABLE IF NOT EXISTS strategy_tick_minutes (
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  minute timestamptz NOT NULL,
  first_tick timestamptz NOT NULL,
  last_tick timestamptz NOT NULL,
  tick_count integer NOT NULL CHECK(tick_count>0),
  PRIMARY KEY(strategy_id,minute)
);

CREATE TABLE IF NOT EXISTS strategy_funding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  applied_at timestamptz NOT NULL,
  amount numeric(40,18) NOT NULL,
  simulated boolean NOT NULL DEFAULT false,
  transaction_hash text,
  UNIQUE(strategy_id,applied_at,simulated)
);
