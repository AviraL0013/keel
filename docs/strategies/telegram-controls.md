# Telegram control transaction boundary

Private commands require an active link whose Telegram sender and private chat match. The command handler locks the user first, then rechecks and locks the captured link, using the same lock order as unlink. It executes the database control change inside the transaction that claims the Telegram update ID. Strategy control methods accept that existing client rather than starting a nested transaction.

An execution or database error rolls back both the update claim and the mutation. The same update can retry safely. A committed update is never executed again, including when sending its reply fails. Replies occur after the connection is released and require a final active-link check. Failed replies currently have no separate reply outbox; avoiding repeated control mutations takes precedence over redelivering an acknowledgement.

The regression suite reproduces a failed command being lost because its update claim committed too early, and a revoked link still mutating controls after the first lookup. Tests also prove rollback after a mid-command database fault, exactly one risk event after retry, fake reply failure without replay, private-chat restrictions, duplicate updates and another user's strategy remaining unchanged.

The unit regressions use local PostgreSQL/WASM fixtures and fake reply functions. They do not send Telegram messages. The separate `node --import tsx scripts/verify-product-concurrency.ts` proof uses independent sessions in an owned temporary local PostgreSQL container. It passes both race orders: an unlink that acquires the user lock first prevents the command; a command that acquires it first commits once before unlink. Replaying the update produces no second risk event. See [the fixture and cleanup limits](capital-admission.md#reproducible-proof).

LIVE strategies remain unavailable; `/resume` only resumes PAPER strategies. Verified live order cleanup remains a separate unfinished requirement.
