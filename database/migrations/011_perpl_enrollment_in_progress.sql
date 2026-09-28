CREATE UNIQUE INDEX IF NOT EXISTS perpl_connections_one_in_progress_wallet
  ON perpl_connections(user_id,wallet_address,environment) WHERE status IN ('PENDING','ENROLLING');
