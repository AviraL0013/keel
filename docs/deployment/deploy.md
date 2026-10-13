# Deployment and operations

Related: [mainnet](mainnet-bounty.md), [credentials](credentials.md), [KMS](aws-kms.md), [Android](android-download.md), [reliability](reliability-run.md), [Perpl](../product/perpl-submission.md), [Agora](../product/agora-submission.md), [API](../api/overview.md). Deployment authorizes no orders or flag changes.

## Environment boundaries

| Profile | Web origin | API and account scope |
| --- | --- | --- |
| Mainnet allowlist demo | `https://app.eyeler.xyz` | Railway `api-mainnet`: `https://api-mainnet-production-b042.up.railway.app`; separate PostgreSQL, per-user accounts, chain 143 |
| Testnet operator | `https://testnet.eyeler.xyz` | Railway `api`: `https://api-production-9fcf.up.railway.app`; existing testnet database and single operator account, chain 10143 |
| Public sandbox | `https://sandbox.eyeler.xyz` | `https://sandbox-api.eyeler.xyz`; `EYELER_ENV=test`, `EYELER_TEST_VENUE=true`, in-memory state |

Vercel serves static Flutter files; clients call Railway directly. `api.eyeler.xyz` is the testnet alias. Never reuse its database/credentials for mainnet. Sandbox has neither and resets on restart.

## Backend configuration

Set secrets through the host secret manager at runtime. Never print values, commit them, include them in reports, or pass them through Flutter defines or image build arguments.

| Group | Names and rules |
| --- | --- |
| Service | `EYELER_ENV`, `PORT` (default `8787`), `DATABASE_URL`, random `SESSION_SECRET`, exact `CORS_ORIGIN`, `EYELER_APP_URL` |
| Accounts/access | `EYELER_PERPL_ACCOUNT_MODE` (`operator` default; mainnet uses `per-user`), `EYELER_ACCESS_MODE` (`allowlist` default), `EYELER_ALLOWED_WALLETS`; `MONAD_WALLET_ADDRESS` is the legacy fallback |
| Venue/chain | `PERPL_REST_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID`, `MONAD_RPC_URL`, `MONAD_CHAIN_ID`, `AUSD_TOKEN_ADDRESS`; use one matching network |
| Operator credentials | Testnet: complete `PERPL_API_KEY`, `PERPL_API_KEY_SECRET`, `PERPL_ACCOUNT_ID` profile and exactly one allowed wallet; all three absent in per-user mainnet |
| Enrollment | `PERPL_ENROLLMENT_ORIGIN`, `EYELER_KEY_TTL_DAYS` (default `90`), paired `EYELER_BUILDER_ID` / `EYELER_MAX_BUILDER_FEE_PER_100K`; leave `EYELER_EGRESS_CIDRS` unset because nonempty restrictions are rejected |
| Trading controls | `EYELER_EXECUTION_DISABLED` defaults to `false`; `EYELER_OPENING_ENABLED` defaults off. `EYELER_STRATEGIES_ENABLED` and `EYELER_STRATEGIES_LIVE_ENABLED` require explicit `true`. Initial mainnet preparation sets the stop to `true` and the other three to `false` |
| Freshness | `EYELER_TICK_STALE_MS=15000`, `EYELER_SAFE_MODE_RESUME_TICKS=5` are defaults |
| Optional workers | Analytics: [operations](../analytics/operations.md). Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`. Agora: [credentials](credentials.md). Secrets stay server-side |

Use the explicit custody profile in [mainnet setup](mainnet-bounty.md); public mainnet requires AWS KMS. Per-user testnet may use `railway-testnet`. Deployed networks reject development custody and `EYELER_KEY_ENCRYPTION_KEY` / `KEEL_KEY_ENCRYPTION_KEY`. Retain keys needed by rows and backups.

Defaults are not production values. Record the serving revision and current names/boolean states before rollout. This cleanup rechecks no production state and changes no configuration or trading permission.

## Release, readiness and rollback

1. Require exact-candidate CI: `validate`, `flutter`, `android`, `container`, `secrets`. Main merges trigger `deploy_web` after these checks. Verify Railway and Vercel serving SHAs; feature CI alone proves no deployment.
2. Back up PostgreSQL and verify restore access. Test additive migrations twice on a populated nonproduction copy. Run `npm run db:migrate:prod` once from the release image before startup. Preserve Book/action history, request IDs and unresolved outcomes.
3. Run one execution replica per environment/account owner. Stop any local backend using that account. Use zero overlap and a 30-second drain; verify old lock release before starting the new owner. Zero overlap alone does not prove exclusivity. Never add a replica to fix readiness.
4. `/health` checks HTTP. `/ready` checks database, worker, venue, fresh `lastTickAgeMs`, `lockOwned`, and reports `executionDisabled`. Readiness does not authorize trading. Inspect migration logs and `EYELER shutdown complete` during handover.
5. Verify frontend network, origin, TLS, build SHA and sign-in. Preserve trading flags during code-only rollout. Never place a real trade as a check. Separate activation requires approved account, capital and loss limits.
6. Before rollback, stop new submissions and assess pending `UNKNOWN`/`PARTIAL` actions and owned resting orders. Restore compatible API/web versions with the same database and needed wrapping keys/KMS access. Database restore cannot undo chain activity. Never reset request IDs or redirect mainnet to the testnet account.

Build with `docker build -t eyeler-api .`; run the direct Node process with an init process and runtime secrets. The [Railway partial](../../.railway/railway.ts) owns only `api` and `sandbox-api`, not `api-mainnet` or PostgreSQL. Review `railway config plan` before an authorized apply; reject removal of resources or secrets. Keep Wait for CI, one replica and `/health` checks.

For names only, save any variable export privately. Run `node scripts/deploy/check-env.mjs testnet <private-file> --railway-json` (or `sandbox`), then delete it without displaying values. This checks names, not values or mainnet readiness.

## Web, Android and compatibility

Use `scripts/deploy/build-web.sh <mainnet|testnet|sandbox>` or the PowerShell helper. Set public `EYELER_BUILD_SHA` to the release commit. Profiles share `apps/mobile/build/web`; publish immediately after the matching build. Flutter defines contain public network data and RP ID only. Never publish test fixtures as live analytics.

Android uses `xyz.eyeler.app` and Mera RP ID `app.eyeler.xyz`. Preserve the release signer/private backup; signing files and passwords stay outside Git. Match its SHA-256 certificate to live `/.well-known/assetlinks.json`: HTTP 200, JSON, no redirect, exact package and both required relations. Verify mainnet API/build SHA and user-operated phone/passkey checks. Compilation alone is not device evidence.

Use canonical `EYELER_*` names; supported `KEEL_*` aliases cannot conflict. Branding preserves durable history. A changed origin requires sign-in and enrollment-origin approval; never pass sessions through redirects/query strings.

## Local helpers and evidence

Windows testnet uses Node 22, Docker, Flutter, Python 3 and Chrome. Keep root `.env` private; use chain 10143, one wallet, PostgreSQL at `127.0.0.1:5432/eyeler`, web `http://localhost:8082`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local/start.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/local/status.ps1
```

The start helper builds, migrates and checks readiness. Stop the backend with Ctrl+C, wait for clean shutdown, then run `scripts/local/stop.ps1`. Keep `eyeler-postgres-data`.

Export read-only evidence with `npm run report:prod -- --from <UTC-ISO> --to <UTC-ISO> --out <path>`; copy it outside the container. Reports do not independently verify receipts. Use the reliability campaign's actual observation window.

`scripts/run/autonomous-run.mjs` sends real testnet DEFEND/REDUCE/EXIT and arms automation on an existing position. It requires separate authorization, private config, and `EYELER_OPERATOR_PRIVATE_KEY` in the environment. Limits: chain 10143, 5 AUSD reserve, 2 AUSD cap, 60–120 minutes. Uncertainty stops the harness without repeated action POSTs. An old UNKNOWN action with execution bound `0` has no proved expiry; investigate without retrying or clearing its row.
