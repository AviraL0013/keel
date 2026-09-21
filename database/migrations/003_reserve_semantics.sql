ALTER TABLE books DROP CONSTRAINT IF EXISTS books_defense_cap_check;
ALTER TABLE reserves DROP CONSTRAINT IF EXISTS reserves_deployed_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'books_defense_cap_positive') THEN
    ALTER TABLE books ADD CONSTRAINT books_defense_cap_positive CHECK (defense_cap > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reserves_cumulative_cap_check') THEN
    ALTER TABLE reserves ADD CONSTRAINT reserves_cumulative_cap_check CHECK (deployed + reserved <= cap);
  END IF;
END $$;
