-- Openings are user-confirmed intents, never Book actions or reserve credits.
CREATE TABLE IF NOT EXISTS opening_previews (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  connection_id uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('testnet','mainnet')),
  account_id bigint NOT NULL CHECK(account_id>0),
  market_id integer NOT NULL CHECK(market_id>0),
  parameters jsonb NOT NULL,
  parameter_hash text NOT NULL,
  quote jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,user_id,connection_id,environment,account_id),
  FOREIGN KEY(connection_id,user_id) REFERENCES perpl_connections(id,user_id)
);
CREATE INDEX IF NOT EXISTS opening_previews_expiry_idx ON opening_previews(expires_at);

CREATE TABLE IF NOT EXISTS opening_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  connection_id uuid NOT NULL,
  environment text NOT NULL CHECK(environment IN ('testnet','mainnet')),
  account_id bigint NOT NULL CHECK(account_id>0),
  market_id integer NOT NULL CHECK(market_id>0),
  side text NOT NULL CHECK(side IN ('LONG','SHORT')),
  size numeric(40,18) NOT NULL CHECK(size>0),
  price_limit numeric(40,18) NOT NULL CHECK(price_limit>0),
  leverage numeric(20,2) NOT NULL CHECK(leverage>=1),
  collateral numeric(40,6) NOT NULL CHECK(collateral>=0),
  fees numeric(40,6) NOT NULL CHECK(fees>=0),
  preview_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('QUEUED','SUBMITTING','SUBMITTED','VERIFYING','CONFIRMED','PARTIAL','FAILED','UNKNOWN')),
  request_id numeric(20,0) CHECK(request_id>0),
  lb bigint CHECK(lb>0),
  venue_progress jsonb,
  evidence jsonb,
  filled_size numeric(40,18),
  average_price numeric(40,18),
  position_id bigint,
  tx_hash text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  resolved_at timestamptz,
  FOREIGN KEY(preview_id,user_id,connection_id,environment,account_id)
    REFERENCES opening_previews(id,user_id,connection_id,environment,account_id),
  UNIQUE(user_id,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS opening_orders_one_unresolved_account
  ON opening_orders(environment,account_id)
  WHERE status IN ('QUEUED','SUBMITTING','SUBMITTED','VERIFYING','UNKNOWN');
-- IOC PARTIAL is settled for openings, unlike Book-action PARTIAL. Never auto-resubmit its remainder.
-- Rebuild the index on re-run too: early 017 fixtures used account_id without environment.
DROP INDEX IF EXISTS opening_orders_request_id_unique;
CREATE UNIQUE INDEX IF NOT EXISTS opening_orders_request_id_unique
  ON opening_orders(environment,account_id,request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS opening_orders_user_time_idx ON opening_orders(user_id,created_at DESC);
