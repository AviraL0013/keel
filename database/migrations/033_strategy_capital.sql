-- Expand only: old releases continue to conservatively hold every LIVE strategy's capital.
CREATE TABLE IF NOT EXISTS strategy_capital_allocations (
  strategy_id uuid PRIMARY KEY,
  environment text NOT NULL,
  account_id bigint NOT NULL,
  market_id integer NOT NULL,
  amount numeric(40,6) NOT NULL CHECK(amount > 0),
  available numeric(40,6) NOT NULL CHECK(available >= 0),
  reserved numeric(40,6) NOT NULL DEFAULT 0 CHECK(reserved >= 0),
  status text NOT NULL CHECK(status IN ('HELD','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(strategy_id,environment,account_id,market_id)
    REFERENCES strategies(id,environment,account_id,market_id),
  CHECK((status='HELD' AND available+reserved=amount) OR
    (status='RELEASED' AND available=0 AND reserved=0))
);
CREATE TABLE IF NOT EXISTS strategy_capital_reservations (
  order_id uuid PRIMARY KEY,
  strategy_id uuid NOT NULL REFERENCES strategy_capital_allocations(strategy_id),
  environment text NOT NULL,
  account_id bigint NOT NULL,
  market_id integer NOT NULL,
  amount numeric(40,6) NOT NULL CHECK(amount > 0),
  intent_hash text NOT NULL CHECK(intent_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN ('HELD','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  FOREIGN KEY(order_id,strategy_id,environment,account_id,market_id)
    REFERENCES strategy_orders(id,strategy_id,environment,account_id,market_id),
  CHECK((status='HELD' AND released_at IS NULL) OR (status='RELEASED' AND released_at IS NOT NULL))
);
