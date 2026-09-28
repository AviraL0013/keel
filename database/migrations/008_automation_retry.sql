CREATE TABLE IF NOT EXISTS automation_retry_episodes (
  book_id uuid PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 3),
  next_attempt_at timestamptz,
  last_action_id uuid NOT NULL REFERENCES actions(id),
  exhausted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
