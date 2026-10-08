-- Additive ledger: existing 030 paper fills remain untouched and readable by old releases.
-- A venue log is one financial event, even if two strategy/order rows claim it.
CREATE TABLE IF NOT EXISTS strategy_verified_fills (
  environment text NOT NULL CHECK(environment IN ('testnet','mainnet')),
  exchange text NOT NULL CHECK(exchange ~ '^0x[a-f0-9]{40}$'),
  transaction_hash text NOT NULL CHECK(transaction_hash ~ '^0x[a-f0-9]{64}$'),
  log_index integer NOT NULL CHECK(log_index >= 0),
  block_hash text NOT NULL CHECK(block_hash ~ '^0x[a-f0-9]{64}$'),
  block_number bigint NOT NULL CHECK(block_number > 0),
  transaction_index integer NOT NULL CHECK(transaction_index >= 0),
  strategy_id uuid NOT NULL,
  order_id uuid NOT NULL,
  account_id bigint NOT NULL,
  market_id integer NOT NULL,
  side text NOT NULL CHECK(side IN ('BUY','SELL')),
  size numeric(78,18) NOT NULL CHECK(size > 0),
  price numeric(78,18) NOT NULL CHECK(price > 0),
  gross_fee numeric(78,18) NOT NULL CHECK(gross_fee >= 0),
  builder_fee numeric(78,18) NOT NULL CHECK(builder_fee >= 0 AND builder_fee <= gross_fee),
  proof_hash text NOT NULL CHECK(proof_hash ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,exchange,transaction_hash,log_index),
  FOREIGN KEY(order_id,strategy_id,environment,account_id,market_id)
    REFERENCES strategy_orders(id,strategy_id,environment,account_id,market_id)
);
CREATE INDEX IF NOT EXISTS strategy_verified_fills_order_idx
  ON strategy_verified_fills(order_id,block_number,transaction_index,log_index);

-- A trusted server checkpoint covers complete finalized receipts, never a client snapshot.
CREATE TABLE IF NOT EXISTS strategy_slot_checkpoints (
  order_id uuid NOT NULL REFERENCES strategy_orders(id),
  through_block bigint NOT NULL CHECK(through_block > 0),
  intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
  block_hash text NOT NULL CHECK(block_hash ~ '^0x[a-f0-9]{64}$'),
  replay_state jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(order_id,through_block)
);
