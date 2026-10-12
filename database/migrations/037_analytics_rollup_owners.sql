-- AccountCreated predates the 35-day bucket window for many active accounts.
-- Keep only the owner dimension and scan progress; no raw log or transaction data.
CREATE TABLE IF NOT EXISTS analytics_rollup_owner (
  account_id numeric(78,0) PRIMARY KEY,
  owner_address text NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_rollup_owner_scan (
  id integer PRIMARY KEY CHECK (id = 1),
  next_block bigint NOT NULL CHECK (next_block >= 54773010)
);
INSERT INTO analytics_rollup_owner_scan(id,next_block)
VALUES(1,54773010) ON CONFLICT (id) DO NOTHING;
