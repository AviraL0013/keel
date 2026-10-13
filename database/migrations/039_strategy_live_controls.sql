-- Expand only. Old releases keep LIVE start disabled; no existing strategy is armed.
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS live_max_run_ms bigint;
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS live_expires_at timestamptz;
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS live_cleanup_pending boolean NOT NULL DEFAULT false;
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS live_consent_hash text;
ALTER TABLE strategies ADD COLUMN IF NOT EXISTS live_state jsonb;
ALTER TABLE strategy_orders ADD COLUMN IF NOT EXISTS execution_origin text NOT NULL DEFAULT 'INTERNAL';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='strategies_live_duration' AND conrelid='strategies'::regclass) THEN
    ALTER TABLE strategies ADD CONSTRAINT strategies_live_duration CHECK (
      live_max_run_ms IS NULL OR live_max_run_ms BETWEEN 60000 AND 86400000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='strategies_live_consent_hash' AND conrelid='strategies'::regclass) THEN
    ALTER TABLE strategies ADD CONSTRAINT strategies_live_consent_hash CHECK (
      live_consent_hash IS NULL OR live_consent_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='strategy_orders_execution_origin' AND conrelid='strategy_orders'::regclass) THEN
    ALTER TABLE strategy_orders ADD CONSTRAINT strategy_orders_execution_origin CHECK (
      execution_origin IN ('INTERNAL','AUTOMATION'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS strategy_live_consents (
  id uuid PRIMARY KEY,
  strategy_id uuid NOT NULL REFERENCES strategies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  environment text NOT NULL CHECK(environment IN ('testnet','mainnet')),
  connection_id uuid NOT NULL,
  account_id bigint NOT NULL CHECK(account_id>0),
  config_hash text NOT NULL CHECK(config_hash ~ '^[a-f0-9]{64}$'),
  strategy_version bigint NOT NULL,
  max_run_ms bigint NOT NULL CHECK(max_run_ms BETWEEN 60000 AND 86400000),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  idempotency_key uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(connection_id,user_id) REFERENCES perpl_connections(id,user_id),
  CHECK ((confirmed_at IS NULL AND idempotency_key IS NULL) OR
    (confirmed_at IS NOT NULL AND idempotency_key IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS strategy_live_consents_idempotency_idx
  ON strategy_live_consents(strategy_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS strategy_live_consents_expiry_idx ON strategy_live_consents(expires_at);
