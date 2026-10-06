CREATE TABLE IF NOT EXISTS telegram_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  telegram_user_id text NOT NULL,
  chat_id text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS telegram_links_active_user ON telegram_links(user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS telegram_links_active_chat ON telegram_links(chat_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS telegram_link_tokens_user ON telegram_link_tokens(user_id);
CREATE TABLE IF NOT EXISTS telegram_webhook_updates (
  update_id bigint PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE telegram_deliveries ADD COLUMN IF NOT EXISTS recipient_link_id uuid REFERENCES telegram_links(id);
ALTER TABLE telegram_deliveries ADD COLUMN IF NOT EXISTS recipient_chat_id text;
ALTER TABLE telegram_deliveries DROP CONSTRAINT IF EXISTS telegram_deliveries_status_check;
ALTER TABLE telegram_deliveries ADD CONSTRAINT telegram_deliveries_status_check CHECK(status IN ('PENDING','SENDING','SENT','UNKNOWN','FAILED','CANCELED'));
