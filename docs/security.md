# Security

- Wallet ownership verified server-side with one-time, message-bound challenge and signature.
- Session challenge, verification, and reuse follow explicit access policy. Allowlist remains the default; removing a wallet invalidates its existing sessions. Public access requires per-user account mode and is never inferred from an empty allowlist.
- Session cookies are HTTP-only and server-controlled; sessions persist in PostgreSQL and support revoke/expiry.
- Perpl API credentials stay server-side. Per-user enrollment and runtime access use the same asynchronous KeyCustody interface, bound to the user and credential ID. AWS KMS generates a fresh data key per credential and wraps it; AES-256-GCM encrypts locally. Mainnet refuses startup without KMS and a successful access probe. DevelopmentKeyCustody is restricted to local/test environments. See [KMS setup, rotation, audit, and recovery](deployment/aws-kms.md).
- Per-Book action uniqueness is enforced by PostgreSQL partial unique index plus runtime advisory lock.
- Stale or malformed telemetry produces SAFE_MODE and blocks new orders. Transient data/venue outages preserve the armed setting and resume only after consecutive fresh ticks; unresolved actions and runtime failures turn automation off.
- UNKNOWN actions reconcile signed venue history before any retry.
- Reserve deployments require confirmed action state, Book cap, available balance, ledger uniqueness, and transaction commit.
- Reduce/exit order construction is reduce-only and reconciles position/fills before confirmation.
- Testnet/mainnet CORS uses explicit origins; development/test accept any origin. Rate limiting, runtime input validation, ownership checks, and notification deduplication are enabled.
- Never log signatures, API keys, private keys, session secrets, raw authorization headers, or credential values.

Live deployment still requires operator-created KMS/role configuration, verified workload authentication and CloudTrail retention, dependency review, external security review, and staged evidence before mainnet use. Local mocked tests do not establish production readiness.
