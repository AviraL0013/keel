# Security

- Wallet ownership verified server-side with one-time, message-bound challenge and signature.
- Session challenge, verification, and reuse require an allowlisted wallet outside test mode; removing a wallet also invalidates its existing sessions.
- Session cookies are HTTP-only and server-controlled; sessions persist in PostgreSQL and support revoke/expiry.
- Perpl secrets stay server-side. Connection API stores only an approved secret-reference identifier, never raw key material.
- Per-Book action uniqueness is enforced by PostgreSQL partial unique index plus runtime advisory lock.
- Stale or malformed telemetry produces SAFE_MODE and blocks new orders. Transient data/venue outages preserve the armed setting and resume only after consecutive fresh ticks; unresolved actions and runtime failures turn automation off.
- UNKNOWN actions reconcile signed venue history before any retry.
- Reserve deployments require confirmed action state, Book cap, available balance, ledger uniqueness, and transaction commit.
- Reduce/exit order construction is reduce-only and reconciles position/fills before confirmation.
- Testnet/mainnet CORS uses explicit origins; development/test accept any origin. Rate limiting, runtime input validation, ownership checks, and notification deduplication are enabled.
- Never log signatures, API keys, private keys, session secrets, raw authorization headers, or credential values.

Live deployment still requires secret-manager integration, dependency review, external security review, and testnet evidence before mainnet use.
