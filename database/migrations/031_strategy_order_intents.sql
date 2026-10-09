-- New real order intents are immutable, scoped, and persisted before transmission.
-- Nullable fields preserve the legacy paper and recovery rows introduced by 030.
ALTER TABLE strategy_orders ADD COLUMN IF NOT EXISTS idempotency_key uuid;
ALTER TABLE strategy_orders ADD COLUMN IF NOT EXISTS wire_order jsonb;
ALTER TABLE strategy_orders ADD COLUMN IF NOT EXISTS payload_hash text;
ALTER TABLE strategy_orders ADD COLUMN IF NOT EXISTS market_terms jsonb;
ALTER TABLE strategy_orders ADD COLUMN IF NOT EXISTS target_order_id uuid;
ALTER TABLE strategy_orders ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS strategy_orders_intent_key_idx
  ON strategy_orders(strategy_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS strategy_orders_ownership_idx
  ON strategy_orders(id,strategy_id,environment,account_id,market_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='strategy_orders_intent_metadata'
    AND conrelid='strategy_orders'::regclass) THEN
    ALTER TABLE strategy_orders ADD CONSTRAINT strategy_orders_intent_metadata CHECK (
      idempotency_key IS NULL OR (
        simulated=false AND wire_order IS NOT NULL AND market_terms IS NOT NULL
        AND payload_hash IS NOT NULL AND payload_hash ~ '^[a-f0-9]{64}$'
        AND ((kind='POST' AND target_order_id IS NULL) OR (kind<>'POST' AND target_order_id IS NOT NULL))
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='strategy_orders_target_owner'
    AND conrelid='strategy_orders'::regclass) THEN
    ALTER TABLE strategy_orders ADD CONSTRAINT strategy_orders_target_owner
      FOREIGN KEY(target_order_id,strategy_id,environment,account_id,market_id)
      REFERENCES strategy_orders(id,strategy_id,environment,account_id,market_id);
  END IF;
END $$;
