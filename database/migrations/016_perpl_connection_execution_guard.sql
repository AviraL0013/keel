-- Existing operator Books have no connection binding and keep their old path.
-- The connection row lock serializes new action admission with local revocation.
CREATE OR REPLACE FUNCTION eyeler_guard_action_connection() RETURNS trigger AS $$
DECLARE connection_id uuid;
BEGIN
  SELECT perpl_connection_id INTO connection_id FROM books WHERE id=NEW.book_id;
  IF connection_id IS NOT NULL THEN
    PERFORM id FROM perpl_connections WHERE id=connection_id AND status='ACTIVE'
      AND revoked_at IS NULL AND expires_at>now() FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PERPL_CONNECTION_UNAVAILABLE'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS actions_require_active_connection ON actions;
CREATE TRIGGER actions_require_active_connection BEFORE INSERT ON actions
  FOR EACH ROW EXECUTE FUNCTION eyeler_guard_action_connection();

CREATE OR REPLACE FUNCTION eyeler_guard_connection_revocation() RETURNS trigger AS $$
BEGIN
  IF NEW.status='REVOKED' AND OLD.status<>'REVOKED' AND EXISTS (
    SELECT 1 FROM books b JOIN actions a ON a.book_id=b.id
    WHERE b.perpl_connection_id=OLD.id
      AND a.status IN ('QUEUED','VALIDATING','SUBMITTING','SUBMITTED','VERIFYING','UNKNOWN','PARTIAL')
  ) THEN RAISE EXCEPTION 'PERPL_CONNECTION_EXECUTION_UNRESOLVED'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS connections_keep_reconciliation_access ON perpl_connections;
CREATE TRIGGER connections_keep_reconciliation_access BEFORE UPDATE ON perpl_connections
  FOR EACH ROW EXECUTE FUNCTION eyeler_guard_connection_revocation();

-- A verified account's owner does not change when its API key rotates.
CREATE TABLE IF NOT EXISTS perpl_account_owners (
  environment text NOT NULL CHECK(environment IN ('testnet','mainnet')),
  account_id bigint NOT NULL CHECK(account_id>0),
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY(environment,account_id)
);
