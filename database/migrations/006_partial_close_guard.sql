DROP INDEX IF EXISTS one_active_action_per_book;
CREATE UNIQUE INDEX one_active_action_per_book ON actions(book_id)
WHERE status IN ('QUEUED','VALIDATING','SUBMITTING','SUBMITTED','VERIFYING','UNKNOWN','PARTIAL');
