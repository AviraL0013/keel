# Eyeler production deployment

This deployment uses one live testnet backend and one isolated public sandbox. The live backend connects to Perpl account 642. Keep the local backend stopped while the live backend runs; never run two owners for that account.

| Component | Service or project | URL | Region |
| --- | --- | --- | --- |
| Live API | Railway `eyeler` / `api` | `https://api.eyeler.xyz` | Southeast Asia (Singapore) |
| Live database | Railway `eyeler` / `Postgres` | Private Railway connection | Southeast Asia (Singapore) |
| Live web | Vercel `eyeler-app` | `https://app.eyeler.xyz` | Vercel edge |
| Sandbox API | Railway `eyeler` / `sandbox-api` | `https://sandbox-api.eyeler.xyz` | Railway-managed |
| Sandbox web | Vercel `eyeler-sandbox` | `https://sandbox.eyeler.xyz` | Vercel edge |

Railway Postgres has point-in-time recovery enabled. The sandbox uses the test venue and in-memory state, resets on restart, and has no Perpl credentials or database.

## Server variables

Configure these names on Railway `api`: `EYELER_ENV`, `EYELER_ALLOWED_WALLETS`, `CORS_ORIGIN`, `EYELER_APP_URL`, `DATABASE_URL`, `SESSION_SECRET`, `PERPL_REST_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID`, `PERPL_API_KEY`, `PERPL_API_KEY_SECRET`, `PERPL_ACCOUNT_ID`, `MONAD_RPC_URL`, `MONAD_CHAIN_ID`, `AUSD_TOKEN_ADDRESS`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`. Telegram settings are optional. Leave `PERPL_ENROLLMENT_ORIGIN`, `EYELER_KEY_ENCRYPTION_KEY`, and Agora settings unset until those integrations are ready. Set secrets in Railway, never in Git or Flutter build arguments.

Configure these names on Railway `sandbox-api`: `EYELER_ENV`, `EYELER_TEST_VENUE`, `CORS_ORIGIN`, `EYELER_APP_URL`, and `SESSION_SECRET`. Do not give the sandbox `DATABASE_URL` or any Perpl credential. The names-only check is `node scripts/deploy/check-env.mjs testnet <private-file> --railway-json` for live or `sandbox` for sandbox; follow [deploy.md](deploy.md) for safe export and cleanup.

## GoDaddy DNS

In GoDaddy DNS for `eyeler.xyz`, keep the existing `@` parked record and `www`. These records serve only the four subdomains. Use TTL 600 seconds, or 1/2 hour when custom TTL is unavailable.

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `api` | `1ktx3n33.up.railway.app` |
| TXT | `_railway-verify.api` | `railway-verify=8cd243e710fcdf62a20aed8da534cfefa0f44fb91f8a189b02a85efb3570d5d1` |
| CNAME | `app` | `afae757fc44d3ffb.vercel-dns-017.com` |
| CNAME | `sandbox-api` | `quxzb4n3.up.railway.app` |
| TXT | `_railway-verify.sandbox-api` | `railway-verify=8c002f305921fca43fb18a81f63166ecb2764e6c36bb302ba6c4a2b01f28a254` |
| CNAME | `sandbox` | `dbe550a277c89a96.vercel-dns-017.com` |

## Redeploy and roll back

Railway service settings are declared in [`.railway/railway.ts`](../../.railway/railway.ts). Review `railway config plan` before `railway config apply`; the partial owns only `api` and `sandbox-api`. The live API has one replica, a `/health` check, and migrations before deploy. Never accept a plan that removes Postgres or existing secret variables. The source branch is `main`, so merge approved deployment configuration before relying on a future source rebuild to reproduce it.

Before restarting or replacing `api`, ensure the local backend is stopped. Stop the old Railway deployment, then deploy the new one with no overlapping process. Check `https://api.eyeler.xyz/health` and `/ready`; `/ready` must report `venueReady: true`, `lockOwned: true`, and a fresh `lastTickAgeMs`. A temporary `/ready` failure must not trigger a second live replica. To roll back, stop the active deployment and redeploy a known-good image only after checking migration compatibility. Keep the database; assess unresolved actions before any database restore.

Build web assets with `scripts/deploy/build-web.ps1 testnet` or `.sh testnet` and deploy `apps/mobile/build/web` to Vercel `eyeler-app`. Use `sandbox` for `eyeler-sandbox`. The two targets share one local output directory, so deploy each immediately after its build. Roll back a web app by promoting its prior Vercel deployment. Web builds contain only public URLs and chain data.

View backend logs in Railway's `api` and `sandbox-api` deployment logs. Look for `PERPL_WS_READY`, tick health, migration results, and `EYELER shutdown complete`. View web deployment logs and releases in their Vercel projects. Do not export secret-bearing variable values into logs or reports.

For a read-only run report, execute `npm run report:prod -- --from <iso> --to <iso> [--book <id>] --out <path>` in the production image with the database connection supplied by Railway. Store the result outside the container. The report command never submits orders.
