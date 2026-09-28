# KEEL deployment

Deploy exactly **one backend instance** per environment. Perpl allows four trading sockets per wallet, and KEEL's one-second tick and request-ID allocation assume a single owner. Use PostgreSQL with automated backups and tested restore. Host the Flutter web build separately on static hosting. Do not put server credentials in that build.

## Live testnet

Set these on the backend host:

| Variable | Purpose |
| --- | --- |
| `KEEL_ENV=testnet` | Enables testnet startup checks. |
| `PORT` | Listener and container healthcheck port; defaults to `8787`. |
| `DATABASE_URL` | Persistent PostgreSQL connection string; back up this database. |
| `SESSION_SECRET` | Random server-side secret, not the development default. |
| `KEEL_ALLOWED_WALLETS` | Comma-separated wallets permitted to sign in. `MONAD_WALLET_ADDRESS` can supply the fallback. |
| `CORS_ORIGIN` | Exact allowed Flutter web origin or comma-separated origins. |
| `PERPL_REST_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID` | Testnet venue endpoints and chain ID. |
| `PERPL_API_KEY`, `PERPL_API_KEY_SECRET`, `PERPL_ACCOUNT_ID` | Server-side Perpl trading account credentials. Never expose them in Flutter. |
| `MONAD_RPC_URL`, `MONAD_CHAIN_ID`, `AUSD_TOKEN_ADDRESS` | Chain and AUSD read-only evidence. |

Set all six `PERPL_*` live settings together. Partial settings fail startup. Check Perpl's separate on-chain order-forwarding permission before arming automation. Keep `PERPL_ENROLLMENT_ORIGIN` and `KEEL_KEY_ENCRYPTION_KEY` unset until Perpl whitelists the exact origin. Per-user enrollment is a backend foundation; Books still use the server-wide key. Optional Agora reads use server-side `AGORA_API_KEY`; no Agora transfer scope is needed.

## Public sandbox

Use a separate backend instance with `KEEL_ENV=test`, `KEEL_TEST_VENUE=true`, `PORT` and a `SESSION_SECRET`. Leave `DATABASE_URL` and all Perpl credentials unset. The sandbox uses an in-memory store and deterministic fake venue. It resets on every restart. Do not point the sandbox at the live testnet database or wallet credentials.

## Build and operate

Build backend image with `docker build -t keel-api .`. Supply environment variables through the host secret manager at runtime, not build arguments or the Flutter bundle. Run one backend replica. Before starting a new backend version, run `npm run db:migrate:prod` once from that version's image with `DATABASE_URL` set. Migrations read `database/migrations` and are additive; back up PostgreSQL first.

Build Flutter web separately:

```sh
cd apps/mobile
flutter build web --release --dart-define=KEEL_API_URL=https://api.<domain>
```

Publish `apps/mobile/build/web` to static hosting with HTTPS. Use the matching backend URL and include that web origin in `CORS_ORIGIN` for live testnet.

`GET /health` returning 200 means HTTP is alive. `GET /ready` returning `{"ready":true}` means the worker, database and venue are ready for live execution. Do not send traffic requiring trading readiness when `/ready` is false. Container healthcheck uses `/health` so a temporary Perpl outage does not cause a restart loop.

For rollback, stop the single backend instance, deploy the previous image, and keep the database. Check migration compatibility before rollback; restore the database backup only when a migration is incompatible and after assessing actions still awaiting reconciliation. Never run two backend versions against the same Perpl account at once. On restart, KEEL reconciles submitted actions instead of submitting them again.

Backend logs go to stdout/stderr and should be collected by the container host. Keep credentials out of logs. Inspect application warnings, action reconciliation, `/ready`, and PostgreSQL health during deploys. Flutter logs remain in the browser console.
