# EYELER deployment

For existing installations changing from the previous name, follow [the Eyeler rebrand rollout](eyeler-rebrand.md). Keep the existing PostgreSQL database and execution history.

Deploy exactly **one backend instance** per environment. Perpl allows four trading sockets per wallet, and EYELER's one-second tick and request-ID allocation assume a single owner. Use PostgreSQL with automated backups and tested restore. Host the Flutter web build separately on static hosting. Do not put server credentials in that build.

## Live testnet

The following describes the existing single-operator deployment. The candidate per-user release uses `EYELER_PERPL_ACCOUNT_MODE=per-user` and removes shared Perpl API credentials. Mainnet permits the explicit [allowlisted demo envelope provider](mainnet-bounty.md) for team wallets; public access still requires [AWS KMS](aws-kms.md). Deployed testnet separately permits versioned Railway custody, never development custody. Do not enable mainnet before the [product release checklist](../product/end-to-end-delivery.md) and operator handover pass. The current [Perpl rollout](perpl-product-rollout.md) lists release blockers and approval checkpoints.

Set these on the backend host:

| Variable                                                    | Purpose                                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EYELER_ENV=testnet`                                        | Enables testnet startup checks.                                                                                                                                          |
| `PORT`                                                      | Listener and container healthcheck port; defaults to `8787`.                                                                                                             |
| `DATABASE_URL`                                              | Persistent PostgreSQL connection string; back up this database.                                                                                                          |
| `SESSION_SECRET`                                            | Random server-side secret, not the development default.                                                                                                                  |
| `EYELER_ALLOWED_WALLETS`                                    | Exactly **one** wallet when live Perpl credentials are set. `MONAD_WALLET_ADDRESS` can supply the fallback. Multiple wallets fail startup until per-user trading exists. |
| `CORS_ORIGIN`                                               | Exact allowed Flutter web origin or comma-separated origins.                                                                                                             |
| `PERPL_REST_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID`          | Testnet venue endpoints and chain ID.                                                                                                                                    |
| `PERPL_API_KEY`, `PERPL_API_KEY_SECRET`, `PERPL_ACCOUNT_ID` | Server-side Perpl trading account credentials. Never expose them in Flutter.                                                                                             |
| `MONAD_RPC_URL`, `MONAD_CHAIN_ID`, `AUSD_TOKEN_ADDRESS`     | Chain and AUSD read-only evidence.                                                                                                                                       |
| `EYELER_EXECUTION_DISABLED`                                 | Set `true` for an emergency stop on all new manual and automated submissions; existing actions still reconcile. Default `false`.                                         |
| `EYELER_TICK_STALE_MS`                                      | `/ready` rejects a stalled monitor tick after this many milliseconds; default `15000`.                                                                                   |
| `EYELER_SAFE_MODE_RESUME_TICKS`                             | Fresh consecutive ticks before transient data/venue SAFE_MODE resumes; default `5`.                                                                                      |
| `EYELER_SNAPSHOT_FULL_HOURS`                                | Keep full-resolution risk snapshots this long; default `48`.                                                                                                             |
| `EYELER_SNAPSHOT_ARCHIVE_DAYS`                              | Keep one snapshot per Book per minute until this age; default `30`. Must exceed the full-resolution window.                                                              |
| `EYELER_SNAPSHOT_RETENTION_BATCH_SIZE`                      | Maximum snapshot deletions per background pass; default `1000`.                                                                                                          |
| `EYELER_SNAPSHOT_RETENTION_INTERVAL_MS`                     | Time between retention passes; default `60000`.                                                                                                                          |

In operator mode, set the complete shared `PERPL_*` credential profile together. Partial settings fail startup. Check Perpl's separate on-chain order-forwarding permission before arming automation. Keep development custody keys unset on deployed networks. In per-user mode, Books use their verified user-owned connection and scoped credentials; do not configure a shared operator key. Enrollment requires the exact approved origin for that environment. Optional Agora reads use server-side `AGORA_API_KEY`; no Agora transfer scope is needed.

`EYELER_KEY_TTL_DAYS`, `EYELER_EGRESS_CIDRS`, `EYELER_BUILDER_ID` and `EYELER_MAX_BUILDER_FEE_PER_100K` apply only to the backend Perpl enrollment foundation; leave them unset for the first deploy. `EYELER_*` configuration still accepts the corresponding `KEEL_*` name during the rebrand. Do not set both names to different values.

Optional operator alerts use `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and HTTPS `EYELER_APP_URL` (the Flutter web origin). Set both Telegram values and the app URL to enable the worker. It sends text and a Book link only; it cannot trigger trades. Delivery status lives in PostgreSQL. Explicit Telegram rejections retry with backoff; an ambiguous network outcome stops automatic retries to avoid duplicate alerts. Review such records in `telegram_deliveries` and compare them with the operator chat before any manual action.

## Public sandbox

Use a separate backend instance with `EYELER_ENV=test`, `EYELER_TEST_VENUE=true`, `PORT` and a `SESSION_SECRET`. Leave `DATABASE_URL` and all Perpl credentials unset. The sandbox uses an in-memory store and deterministic fake venue. It resets on every restart. Do not point the sandbox at the live testnet database or wallet credentials.

## Railway configuration (planned, not deployed)

Railway's current [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) lives in [`.railway/railway.ts`](../../.railway/railway.ts). Its named partial owns only `api` and `sandbox-api`; do not apply a plan that removes an existing service or PostgreSQL resource. The config builds the root Dockerfile, sets one replica and zero deployment overlap delay, runs compiled migrations before `api` deploys, checks `/health`, and restarts on failure. The sandbox has no pre-deploy migration. Railway's older `railway.json`/`railway.toml` format is deprecated and cannot be adopted for new services.

Before first use, create/link the Railway project and PostgreSQL service, then supply the testnet variables from the table above to `api` through Railway's secret settings. Set `DATABASE_URL` from PostgreSQL. Supply only `SESSION_SECRET` to `sandbox-api`; the config sets `EYELER_ENV=test` and `EYELER_TEST_VENUE=true`. Leave all Perpl keys and `DATABASE_URL` absent from sandbox. Keep `PERPL_ENROLLMENT_ORIGIN` and `EYELER_KEY_ENCRYPTION_KEY` unset until Perpl whitelists the origin. Set `EYELER_APP_URL=https://app.eyeler.xyz` for optional Telegram Book links.

Validate names without echoing values: export `railway variables --json` to a private temporary file, then run `node scripts/deploy/check-env.mjs testnet <file> --railway-json` for `api` or `node scripts/deploy/check-env.mjs sandbox <file> --railway-json` for sandbox. An env-file path works without `--railway-json`. Delete the temporary export after checking. The script checks required variable names only; the backend performs value validation at startup. Then run `railway config plan` and inspect the entire plan before `railway config apply`. Neither command is run by this repository's CI. Back up PostgreSQL and confirm migration compatibility before deploy.

The trading service must have exactly one running process. Railway's zero overlap delay does not by itself prove that a new process cannot briefly coexist with an old process during activation. For a live rollout, pause trading, stop the old `api` deployment, then deploy the new revision with downtime; inspect `/ready` and the advisory lock before re-enabling trading. Keep the sandbox separate. Never enable multiple regions or replicas for `api`.

Build the web app with `scripts/deploy/build-web.sh testnet` (bash/zsh) or `scripts/deploy/build-web.ps1 testnet` (PowerShell). Use `sandbox` for the public sandbox. Both pass the matching API URL and public Monad testnet wallet settings. Publish `apps/mobile/build/web` to Vercel; do not put backend secrets in Dart defines.

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
