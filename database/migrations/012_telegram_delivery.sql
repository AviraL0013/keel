ALTER TABLE notifications ADD COLUMN IF NOT EXISTS book_id uuid REFERENCES books(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS telegram_deliveries (
  notification_id uuid PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
  status text NOT NULL CHECK(status IN ('PENDING','SENDING','SENT','UNKNOWN')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  delivered_at timestamptz,
  last_error text
);
CREATE INDEX IF NOT EXISTS telegram_deliveries_due_idx ON telegram_deliveries(next_attempt_at) WHERE status='PENDING';
