-- Earlier workers set this flag when configured at deployment, before replay.
-- Version makes this downgrade safe if migrations are re-run.
ALTER TABLE analytics_checkpoint ADD COLUMN IF NOT EXISTS history_proof_version smallint NOT NULL DEFAULT 0;
UPDATE analytics_checkpoint
SET history_verified=false, history_proof_version=1, updated_at=now()
WHERE history_proof_version=0;
ALTER TABLE analytics_checkpoint ALTER COLUMN history_proof_version SET DEFAULT 1;
