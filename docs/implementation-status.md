# Implementation status — 2026-09-29

Eyeler is a Flutter client and a TypeScript/Fastify modular monolith. The server owns wallet-session authentication, the deterministic risk engine, Perpl execution and reconciliation, PostgreSQL reserve/evidence records, Monad AUSD reads, optional read-only Agora activity, and optional operator Telegram alerts. The public sandbox uses the same API and policy path with an explicitly labeled deterministic in-memory venue.

## Verified in this hardening run

- `npm ci`, `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`, and `npm run smoke:prod` passed locally.
- `npm test`: **333 tests in 55 files** passed after the scripted demo test; baseline at `41ff4e8` was 307 tests in 48 files.
- Flutter 3.47.5: `flutter analyze` clean, `dart format --set-exit-if-changed` clean, **58 widget/unit tests** passed; baseline was 57.
- A local Docker image returned `/health` 200, stopped with exit code 0, and logged completed shutdown. CI now checks this path; the remote CI result remains pending.
- Flutter release web built and copied the Vercel headers/caching config. The actual Vercel response headers remain unverified until deploy.
- Local Android APK verification is blocked by the missing Android NDK `27.0.12077973`; Flutter analyze/tests pass. The Android application ID, namespace and Kotlin package are `xyz.eyeler.app`.
- The report command and its PGlite fixture pass. A one-hour **live** report remains to be collected after deployment.

## Safety and deployment limits

Live trading remains one Perpl account, one allowlisted wallet and one backend instance. Multi-wallet startup with the server-wide trading key is refused. Emergency execution disable stops new actions while existing submissions continue to reconcile. Reserve arithmetic is exact at six AUSD decimals; invalid sub-micro amounts fail closed. UNKNOWN/PARTIAL actions are not automatically resubmitted.

Native WalletConnect, per-user trading runtime, production KMS custody, the Perpl enrollment screen pending origin whitelisting, and composable contracts are out of scope. Backend enrollment rows are not bound to live Books. The [audit](audit/pre-deploy-audit.md) tracks remaining deployment verification and lower-priority findings.
