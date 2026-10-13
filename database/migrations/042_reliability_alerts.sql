-- Expand-only, backwards-compatible alert evidence. A durable claim is never
-- retried automatically, including after an ambiguous network or process exit.
CREATE TABLE IF NOT EXISTS reliability_alert_deliveries (
  incident_id uuid PRIMARY KEY REFERENCES reliability_incidents(id),
  run_id uuid NOT NULL REFERENCES reliability_runs(id),
  recipient_link_id uuid NOT NULL REFERENCES telegram_links(id),
  status text NOT NULL CHECK (status IN ('SENDING','SENT','FAILED','UNKNOWN','CANCELED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text CHECK (last_error IS NULL OR last_error IN (
    'OUTCOME_UNKNOWN','TELEGRAM_REJECTED','OWNER_LINK_REVOKED','INCIDENT_NO_LONGER_ACTIVE'
  ))
);
CREATE INDEX IF NOT EXISTS reliability_alert_deliveries_run ON reliability_alert_deliveries(run_id,status);
