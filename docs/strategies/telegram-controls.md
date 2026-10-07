# Telegram control transaction boundary

Private commands require an active link whose Telegram sender and private chat match. The command handler locks the user first, then rechecks and locks the captured link, using the same lock order as unlink. It executes the database control change inside the transaction that claims the Telegram update ID. Strategy control methods accept that existing client rather than starting a nested transaction.

An execution or database error rolls back both the update claim and the mutation. The same update can retry safely. A committed update is never executed again, including when sending its reply fails. Replies occur after the connection is released and require a final active-link check. Failed replies currently have no separate reply outbox; avoiding repeated control mutations takes precedence over redelivering an acknowledgement.

The regression suite reproduces a failed command being lost because its update claim committed too early, and a revoked link still mutating controls after the first lookup. Tests also prove rollback after a mid-command database fault, exactly one risk event after retry, fake reply failure without replay, private-chat restrictions, duplicate updates and another user's strategy remaining unchanged.

These tests use local PostgreSQL/WASM fixtures and fake reply functions. They do not send Telegram messages. An injected revocation proves the second authorization check, but this fixture uses one database session and does not prove independent-session PostgreSQL lock races. That separate concurrency proof remains required before live strategy activation. LIVE strategies remain unavailable; `/resume` only resumes PAPER strategies.
