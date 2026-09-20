CREATE UNIQUE INDEX IF NOT EXISTS reserve_deployment_once ON reserve_ledger_entries(action_id) WHERE type='RESERVE_DEPLOYED';
ALTER TABLE books ADD COLUMN IF NOT EXISTS venue_account_id bigint;
ALTER TABLE books ADD COLUMN IF NOT EXISTS venue_position_id bigint;
ALTER TABLE books ADD COLUMN IF NOT EXISTS market_id integer;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS observed_at timestamptz;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS request_id bigint;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS before_state jsonb;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS evidence jsonb;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS amount numeric NOT NULL DEFAULT 0;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS fingerprint text;
CREATE TABLE IF NOT EXISTS defense_performance (
  action_id uuid PRIMARY KEY REFERENCES actions(id),
  book_id uuid NOT NULL REFERENCES books(id),
  amount numeric NOT NULL CHECK(amount>0),
  efficiency numeric NOT NULL,
  measurement jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS defense_performance_book_time ON defense_performance(book_id,created_at DESC);
CREATE TABLE IF NOT EXISTS auth_challenges(address text NOT NULL, nonce text NOT NULL, expires_at bigint NOT NULL, consumed_at timestamptz, PRIMARY KEY(address,nonce));
ALTER TABLE auth_challenges ADD COLUMN IF NOT EXISTS message text NOT NULL DEFAULT '';
