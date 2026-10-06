-- Existing operator Books remain explicitly unbound; never guess their owner key.
CREATE UNIQUE INDEX IF NOT EXISTS perpl_connections_id_user_unique ON perpl_connections(id,user_id);
ALTER TABLE books ADD COLUMN IF NOT EXISTS perpl_connection_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='books_connection_owner_fk' AND conrelid='books'::regclass) THEN
    ALTER TABLE books ADD CONSTRAINT books_connection_owner_fk
      FOREIGN KEY(perpl_connection_id,user_id) REFERENCES perpl_connections(id,user_id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS books_connection_idx ON books(perpl_connection_id);
