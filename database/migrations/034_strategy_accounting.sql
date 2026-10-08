-- Durable projection inputs. Rows exist only after StrategyFillLedger verifies
-- receipt, signed history and immutable order identity.
CREATE TABLE IF NOT EXISTS strategy_accounting_events (
  environment text NOT NULL CHECK(environment IN ('testnet','mainnet')),
  strategy_id uuid NOT NULL,
  order_id uuid NOT NULL,
  account_id bigint NOT NULL CHECK(account_id > 0),
  market_id integer NOT NULL CHECK(market_id > 0),
  event_identity text NOT NULL CHECK(length(event_identity) BETWEEN 3 AND 512),
  block_number bigint NOT NULL CHECK(block_number > 0),
  transaction_index integer NOT NULL CHECK(transaction_index >= 0),
  log_index integer NOT NULL CHECK(log_index >= 0),
  side text NOT NULL CHECK(side IN ('BUY','SELL')),
  size numeric(78,18) NOT NULL CHECK(size > 0),
  price numeric(78,18) NOT NULL CHECK(price > 0),
  fee numeric(78,18) NOT NULL CHECK(fee >= 0),
  proof jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,strategy_id,event_identity),
  UNIQUE(environment,strategy_id,block_number,transaction_index,log_index),
  FOREIGN KEY(order_id,strategy_id,environment,account_id,market_id)
    REFERENCES strategy_orders(id,strategy_id,environment,account_id,market_id)
);

CREATE TABLE IF NOT EXISTS strategy_accounting_projection (
  environment text NOT NULL CHECK(environment IN ('testnet','mainnet')),
  strategy_id uuid NOT NULL,
  market_id integer NOT NULL CHECK(market_id > 0),
  position_size numeric(78,18) NOT NULL DEFAULT 0,
  average_entry numeric(78,18),
  realized_pnl numeric(78,18) NOT NULL DEFAULT 0,
  fees_paid numeric(78,18) NOT NULL DEFAULT 0,
  funding_paid numeric(78,18) NOT NULL DEFAULT 0,
  last_block bigint NOT NULL,
  last_transaction_index integer NOT NULL,
  last_log_index integer NOT NULL,
  applied_count integer NOT NULL CHECK(applied_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,strategy_id,market_id),
  FOREIGN KEY(strategy_id) REFERENCES strategies(id)
);
