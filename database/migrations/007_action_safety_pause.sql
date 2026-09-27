ALTER TABLE books ADD COLUMN IF NOT EXISTS safety_action_id uuid REFERENCES actions(id) ON DELETE SET NULL;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS venue_progress jsonb;
