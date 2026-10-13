-- Expand only. Existing strategy control and accounting tables are unchanged.
-- A public page reads only an owner-reviewed immutable artifact, never live private data.
CREATE TABLE IF NOT EXISTS strategy_evidence_publications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  environment text NOT NULL CHECK(environment IN ('testnet','mainnet')),
  artifact jsonb NOT NULL CHECK(jsonb_typeof(artifact)='object' AND artifact->>'visibility'='OWNER_REVIEWED_PUBLIC'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK(revoked_at IS NULL OR revoked_at>=created_at)
);
CREATE INDEX IF NOT EXISTS strategy_evidence_publications_owner_idx
  ON strategy_evidence_publications(user_id,environment,created_at);

CREATE OR REPLACE FUNCTION strategy_evidence_publication_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.artifact IS DISTINCT FROM OLD.artifact
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'STRATEGY_EVIDENCE_ARTIFACT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS strategy_evidence_publication_immutable ON strategy_evidence_publications;
CREATE TRIGGER strategy_evidence_publication_immutable BEFORE UPDATE ON strategy_evidence_publications
  FOR EACH ROW EXECUTE FUNCTION strategy_evidence_publication_immutable();
