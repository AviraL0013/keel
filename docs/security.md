# Security

- Wallet ownership is verified server-side using a one-time message-bound challenge and signature. Native Mera passkeys and wallet signing stay on the device.
- Session cookies are HTTP-only. PostgreSQL stores session expiry and revocation. Access follows explicit configuration; an empty allowlist never silently enables public access. Removing an allowed wallet invalidates its sessions.
- Per-user Perpl enrollment binds the credential to its owner, connection and account. Credentials stay server-side and request trade-only access, without withdrawal permission.
- Public mainnet access requires AWS KMS custody and a successful startup probe. The explicit `railway-allowlist-demo` exception requires mainnet per-user mode, a nonempty allowlist and valid versioned wrapping keys. Local development custody is rejected on deployed networks. See [custody and recovery](deployment/aws-kms.md).
- Credential envelopes are bound to environment, user and credential identity. New wraps and retained key versions must remain readable during rotation. No fallback grants broader access if custody fails.
- Book actions use database uniqueness, account capital admission and worker locks. New execution requires owner authorization, current connection authority and fresh telemetry.
- Stale or malformed telemetry pauses execution. Transient data outages resume only under the configured fresh-tick policy; unresolved actions and runtime failures disable automation.
- UNKNOWN and PARTIAL actions are reconciled rather than blindly resubmitted. Reserve debits require confirmed action evidence and transactional uniqueness. REDUCE and EXIT remain reduce-only.
- LIVE Autopilot has separate reviewed consent and dedicated-account limits. Stop and kill do not guarantee that an exposed position is flattened. See [execution limits](strategies/mainnet-autopilot.md).
- Deployed CORS uses explicit approved origins. Authentication, enrollment and opening endpoints apply validation, rate limits and ownership checks. Public analytics uses a separate GET-only transport; it cannot access private Books or credentials.
- Never log or publish private keys, passkey material, API credentials, session secrets, authorization headers, credential envelopes, or secret-bearing configuration exports.

Automated tests and historical demonstrations are not an external security audit or a guarantee of production readiness. Deployment requires verified custody, migration compatibility, the correct worker lease, current safety settings and retained rollback evidence.
