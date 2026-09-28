# EYELER deployment

For existing installations changing from the previous name, follow [the Eyeler rebrand rollout](eyeler-rebrand.md). Keep the existing PostgreSQL database and execution history.

Deploy exactly **one backend instance** per environment. Perpl allows four trading sockets per wallet, and EYELER's one-second tick and request-ID allocation assume a single owner. Use PostgreSQL with automated backups and tested restore. Host the Flutter web build separately on static hosting. Do not put server credentials in that build.

## Live testnet

Set these on the backend host:

| Variable | Purpose |
| --- | --- |
| `EYELER_ENV=testnet` | Enables testnet startup checks. |
| `PORT` | Listener and container healthcheck port; defaults to `8787`. |
| `DATABASE_URL` | Persistent PostgreSQL connection string; back up this database. |
| `SESSION_SECRET` | Random server-side secret, not the development default. |
| `EYELER_ALLOWED_WALLETS` | Exactly **one** wallet when live Perpl credentials are set. `MONAD_WALLET_ADDRESS` can supply the fallback. Multiple wallets fail startup until per-user trading exists. |
| `CORS_ORIGIN` | Exact allowed Flutter web origin or comma-separated origins. |
| `PERPL_REST_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID` | Testnet venue endpoints and chain ID. |
| `PERPL_API_KEY`, `PERPL_API_KEY_SECRET`, `PERPL_ACCOUNT_ID` | Server-side Perpl trading account credentials. Never expose them in Flutter. |
| `MONAD_RPC_URL`, `MONAD_CHAIN_ID`, `AUSD_TOKEN_ADDRESS` | Chain and AUSD read-only evidence. |
| `EYELER_EXECUTION_DISABLED` | Set `true` for an emergency stop on all new manual and automated submissions; existing actions still reconcile. Default `false`. |
| `EYELER_TICK_STALE_MS` | `/ready` rejects a stalled monitor tick after this many milliseconds; default `15000`. |
| `EYELER_SAFE_MODE_RESUME_TICKS` | Fresh consecutive ticks before transient data/venue SAFE_MODE resumes; default `5`. |
| `EYELER_SNAPSHOT_FULL_HOURS` | Keep full-resolution risk snapshots this long; default `48`. |
| `EYELER_SNAPSHOT_ARCHIVE_DAYS` | Keep one snapshot per Book per minute until this age; default `30`. Must exceed the full-resolution window. |
| `EYELER_SNAPSHOT_RETENTION_BATCH_SIZE` | Maximum snapshot deletions per background pass; default `1000`. |
| `EYELER_SNAPSHOT_RETENTION_INTERVAL_MS` | Time between retention passes; default `60000`. |

Set all six `PERPL_*` live settings together. Partial settings fail startup. Check Perpl's separate on-chain order-forwarding permission before arming automation. Keep `PERPL_ENROLLMENT_ORIGIN` and `EYELER_KEY_ENCRYPTION_KEY` unset until Perpl whitelists the exact origin. Per-user enrollment is a backend foundation; Books still use the server-wide key. Optional Agora reads use server-side `AGORA_API_KEY`; no Agora transfer scope is needed.

`EYELER_KEY_TTL_DAYS`, `EYELER_EGRESS_CIDRS`, `EYELER_BUILDER_ID` and `EYELER_MAX_BUILDER_FEE_PER_100K` apply only to the backend Perpl enrollment foundation; leave them unset for the first deploy. `EYELER_*` configuration still accepts the corresponding `KEEL_*` name during the rebrand. Do not set both names to different values.

Optional operator alerts use `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and HTTPS `EYELER_APP_URL` (the Flutter web origin). Set both Telegram values and the app URL to enable the worker. It sends text and a Book link only; it cannot trigger trades. Delivery status lives in PostgreSQL. Explicit Telegram rejections retry with backoff; an ambiguous network outcome stops automatic retries to avoid duplicate alerts. Review such records in `telegram_deliveries` and compare them with the operator chat before any manual action.

## Public sandbox

Use a separate backend instance with `EYELER_ENV=test`, `EYELER_TEST_VENUE=true`, `PORT` and a `SESSION_SECRET`. Leave `DATABASE_URL` and all Perpl credentials unset. The sandbox uses an in-memory store and deterministic fake venue. It resets on every restart. Do not point the sandbox at the live testnet database or wallet credentials.

## Build and operate

Build backend image with `docker build -t eyeler-api .`. Its direct process is `node dist/server/src/index.js`, so SIGTERM reaches the shutdown handler. Start it with an init process (`docker run --init ... eyeler-api`) and one backend replica. Supply environment variables through the host secret manager at runtime, not build arguments or the Flutter bundle. Before starting a new backend version, run `npm run db:migrate:prod` once from that version's image with `DATABASE_URL` set. Migrations read `database/migrations` and are additive; back up PostgreSQL first. Stop with `docker stop -t 30` and check the `EYELER shutdown complete` log line.

Build Flutter web separately:

```sh
cd apps/mobile
flutter build web --release --dart-define=EYELER_API_URL=https://api.<domain>
```

Publish `apps/mobile/build/web` to Vercel as the deployment directory (the generated directory includes `vercel.json`). Its headers deny framing and disable stale caching for Flutter boot files. Use HTTPS, the matching backend URL, and include that web origin in `CORS_ORIGIN` for live testnet. The app uses Flutter's default hash routing, so no server-side path rewrite is required.

For web wallet network setup, also pass `--dart-define=EYELER_CHAIN_ID=10143`, `--dart-define=EYELER_CHAIN_NAME=Monad Testnet`, `--dart-define=EYELER_MONAD_RPC_URL=<approved-testnet-rpc>`, `--dart-define=EYELER_MONAD_EXPLORER_URL=<approved-testnet-explorer>`, `--dart-define=EYELER_NATIVE_CURRENCY_NAME=Monad` and `--dart-define=EYELER_NATIVE_CURRENCY_SYMBOL=MON`. These are public chain details. Without RPC and explorer URLs, EYELER can switch an already-known chain but cannot add an unknown chain to a wallet.

`GET /health` returning 200 means HTTP is alive. `GET /ready` returning `{"ready":true}` means the worker, database, venue and latest monitor tick are current. Its body includes tick age, lock ownership, venue readiness and `executionDisabled`; a `true` emergency stop may coexist with HTTP readiness but blocks every new submission. Do not send traffic requiring trading readiness when `/ready` is false. Container healthcheck uses `/health` so a temporary Perpl outage does not cause a restart loop.

For Perpl's one-hour evidence request, after the run execute `npm run report:prod -- --from <iso> --to <iso> [--book <id>]` inside the image, or `npm run report -- --from <iso> --to <iso> [--book <id>]` in a development checkout. Set server-side `EYELER_MONAD_EXPLORER_URL` to include explorer links. The command writes `reports/eyeler-run-<from>.md` by default; `--out <path>` chooses another location. Keep the report artifact outside the container before replacing it. The report reads PostgreSQL only and never submits orders.

For rollback, stop the single backend instance, deploy the previous image, and keep the database. Check migration compatibility before rollback; restore the database backup only when a migration is incompatible and after assessing actions still awaiting reconciliation. Never run two backend versions against the same Perpl account at once. On restart, EYELER reconciles submitted actions instead of submitting them again.

Backend logs go to stdout/stderr and should be collected by the container host. Keep credentials out of logs. Inspect application warnings, action reconciliation, `/ready`, and PostgreSQL health during deploys. Flutter logs remain in the browser console.
