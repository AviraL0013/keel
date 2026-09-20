ALTER TABLE risk_snapshots ADD COLUMN IF NOT EXISTS bid numeric;
ALTER TABLE risk_snapshots ADD COLUMN IF NOT EXISTS ask numeric;
ALTER TABLE risk_snapshots ADD COLUMN IF NOT EXISTS mid numeric;
