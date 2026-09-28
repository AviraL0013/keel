ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS wallet_address text;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS public_key text;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS sealed_private_key text;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS sealed_api_token text;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS sealed_mac text;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS typed_data jsonb;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS scope_mask integer;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS ip_cidrs jsonb;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS pending_expires_at timestamptz;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS builder_id smallint;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS builder_fee_ceiling smallint;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE perpl_connections ADD COLUMN IF NOT EXISTS shredded_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS perpl_connections_one_active_wallet
  ON perpl_connections(user_id,wallet_address,environment) WHERE status='ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS perpl_connections_one_pending_wallet
  ON perpl_connections(user_id,wallet_address,environment) WHERE status='PENDING';

CREATE TABLE IF NOT EXISTS perpl_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES perpl_connections(id) ON DELETE CASCADE,
  account_id bigint NOT NULL,
  forwarding boolean,
  frozen boolean,
  last_seen_at timestamptz,
  UNIQUE(connection_id,account_id)
);
