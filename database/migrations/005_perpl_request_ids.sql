CREATE TABLE IF NOT EXISTS perpl_request_ids (
  account_id bigint PRIMARY KEY,
  last_rq numeric(20,0) NOT NULL DEFAULT 0 CHECK (last_rq >= 0 AND last_rq <= 18446744073709551615)
);
