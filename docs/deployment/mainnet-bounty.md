# Mera / Perpl mainnet bounty rollout

This is a deployment plan, not authorization to send a transaction. The current production web app and Railway `api` remain the testnet operator deployment until cutover. Do not apply this plan before release CI, signed Android phone testing, signing-file backup and separate operator approval. An allowlisted per-user demo may use the versioned Railway-secret envelope provider described below. Public access still requires AWS KMS.

## Fixed mainnet profile

The Android package is `xyz.eyeler.app`. Mera uses RP ID `app.eyeler.xyz`; the app and the production web origin must keep that exact domain. The same passkey and RP ID derive the same wallet on both networks, but the newly created Mera wallet is **not** the existing externally funded Perpl wallet. Fund the Mera address itself with AUSD and MON only after verifying the full address on the phone. The app requires an explicit confirmation for each approval, account creation, and forwarding transaction. It never deposits or trades automatically.

Mainnet constants, checked against Perpl's public `/api/v1/pub/context` on 2026-10-07:

| Item                                    | Value                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Perpl REST                              | `https://app.perpl.xyz/api`                                                |
| Perpl trading WebSocket                 | `wss://app.perpl.xyz`                                                      |
| Monad chain ID / RPC                    | `143` / `https://rpc.monad.xyz`                                            |
| Explorer                                | `https://monadscan.com`                                                    |
| Exchange                                | `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`                               |
| AUSD                                    | `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, 6 decimals                   |
| Current minimum account-opening deposit | `10.000000 AUSD`; the wizard reads the current minimum again before acting |
| Builder                                 | ID `25`, fee ceiling `0`                                                   |

The backend refuses a mixed mainnet/testnet configuration. The Android wizard rejects a changed Exchange, AUSD token, chain, or a minimum below 10 AUSD. It reads current account, AUSD balance, allowance, and authenticated forwarding state before offering each step. A submitted transaction with no known outcome remains blocked; the user must review the chain before any further attempt. No fallback RPC or alternate account is used after a 401/403.

## Railway mainnet service

Create a separate mainnet API service and PostgreSQL database. Keep the operator testnet service and its database intact. Migrations run as the pre-deploy step. Use one replica, zero overlap, 30-second drain, `/health` health check, and Wait for CI. Set the following **names** in Railway; values belong in its secure variables, never in Git or Flutter defines:

| Variable                                                   | Required setting                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `EYELER_ENV`                                               | `mainnet`                                                                                                    |
| `EYELER_PERPL_ACCOUNT_MODE`                                | `per-user`                                                                                                   |
| `EYELER_ACCESS_MODE`                                       | `allowlist`                                                                                                  |
| `EYELER_ALLOWED_WALLETS`                                   | Mera wallet address after phone creation, plus explicitly approved team wallets only                         |
| `EYELER_OPENING_ENABLED`                                   | `false` for the execution-disabled canary; enable only at the separately approved trading cutover           |
| `EYELER_EXECUTION_DISABLED`                                | Keep `true` until custody, per-user enrollment and readiness checks pass; then deliberate cutover to `false` |
| `DATABASE_URL`                                             | New mainnet PostgreSQL database; never the testnet database                                                  |
| `SESSION_SECRET`                                           | New independent mainnet secret                                                                               |
| `CORS_ORIGIN`, `EYELER_APP_URL`, `PERPL_ENROLLMENT_ORIGIN` | `https://app.eyeler.xyz`                                                                                     |
| `PERPL_REST_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID`         | `https://app.perpl.xyz/api`, `wss://app.perpl.xyz`, `143`                                                    |
| `EYELER_BUILDER_ID`, `EYELER_MAX_BUILDER_FEE_PER_100K`     | `25`, `0`                                                                                                    |
| `MONAD_RPC_URL`, `MONAD_CHAIN_ID`, `AUSD_TOKEN_ADDRESS`    | `https://rpc.monad.xyz`, `143`, mainnet AUSD address above                                                   |
| `EYELER_KEY_CUSTODY`                                       | `railway-allowlist-demo` for the approved team-wallet demo, or `aws-kms` for a later KMS rollout             |
| `EYELER_DEMO_CUSTODY_KEYS`                                 | Railway secret containing a version-to-32-byte-key map; never print or put in a build                        |
| `EYELER_DEMO_CUSTODY_ACTIVE_VERSION`                       | Version used for new credential envelopes; retain old versions until every old row and backup is retired     |
| `EYELER_STRATEGIES_ENABLED`, `EYELER_STRATEGIES_LIVE_ENABLED` | `false`; LIVE grid remains blocked until its verified accounting and cancellation gates pass                 |
| `EYELER_ANALYTICS_ENABLED`                                 | `false` at initial API canary; enable only with a separately verified read-only indexer service             |
| `AWS_REGION`, `EYELER_KMS_KEY_ARN`                         | Required only when `EYELER_KEY_CUSTODY=aws-kms`; unset for the demo provider                                 |
| `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`              | Only if Railway can supply an actual workload identity; role ARN alone is insufficient                       |
| `EYELER_KMS_DECRYPT_KEY_ARNS`                              | Optional old key ARNs during controlled rotation                                                             |
| `TELEGRAM_BOT_TOKEN`                                       | Optional; existing bot credential managed only in Railway                                                    |
| `EYELER_APP_URL`                                           | Also used for Telegram Book links; must point to mainnet app                                                 |

Do not set shared `PERPL_API_KEY`, `PERPL_API_KEY_SECRET`, or `PERPL_ACCOUNT_ID` on mainnet. Do not set `EYELER_KEY_ENCRYPTION_KEY` or `KEEL_KEY_ENCRYPTION_KEY`. `railway-allowlist-demo` starts only with explicit mainnet, per-user accounts, `EYELER_ACCESS_MODE=allowlist`, a nonempty wallet allowlist, and valid versioned keys. It rejects public or operator mode. A random data key encrypts each credential; its envelope is bound to environment, database user ID and credential ID. Keep old wrapping-key versions readable during rotation. Losing all configured versions makes retained credentials unreadable. Railway secret access and application logs need restricted access; this mode does not provide KMS audit and access isolation. For public access, configure [AWS KMS](aws-kms.md) instead.

### Safe variable preparation after approval

Create an empty separate Railway service whose name contains `mainnet`, and attach a separate mainnet PostgreSQL database through Railway's private `DATABASE_URL` reference. Review the target project UUID, `production` environment, service and public Mera address. Before the rollout approval, run only the names-only preview:

```text
node scripts/deploy/prepare-mainnet-railway.mjs --service api-mainnet --environment production --project <Railway project UUID> --wallet <public Mera address>
```

After the separate configuration approval, repeat with `--apply`. The script refuses the existing `api` service, inherited shared Perpl credentials, and any target names already present. It sets fixed non-secret mainnet variables with `--skip-deploys`, leaves openings/strategy LIVE/analytics off and execution disabled, generates a new session secret and versioned demo wrapping key in memory, and passes both secrets to `railway variable set KEY --stdin --skip-deploys`. It prints names only. It never sets `DATABASE_URL`, bot tokens, or shared Perpl API keys. If interrupted, it reports which names were written; do not rerun until the partial Railway state is reviewed. Railway secret values and logs must remain restricted. This is preparation, not a deploy or trading authorization.

## Web and Android

`scripts/deploy/build-web.sh mainnet` builds the mainnet Flutter web profile for `app.eyeler.xyz`. Its API is the direct Railway hostname `https://api-mainnet-production-b042.up.railway.app`, with `EYELER_DEPLOYMENT=mainnet`, chain 143, Monad mainnet RPC and explorer, `EYELER_MERA_RP_ID=app.eyeler.xyz`, and `EYELER_BUILD_SHA=<commit>`. The Android mainnet build must use the same direct API URL. The generated hostname is public HTTPS and needs no GoDaddy record. The browser app is served as static files by Vercel; API requests go directly to Railway.

The GitHub `deploy_web` job builds mainnet for `app.eyeler.xyz` only after this release branch merges to main and all five validation jobs pass. It builds the sandbox separately. Configure Vercel to serve `/.well-known/assetlinks.json` directly from the app build with HTTP 200, JSON content type, and no redirect. Verify the SHA-256 fingerprint against the backed-up release keystore before publishing. Android release signing must read keystore path and passwords from local files or environment only. Never commit the keystore, passwords, or `key.properties`.

## Cutover order and rollback

### Direct Railway API and testnet web DNS

Railway Trial refused a second custom domain on the existing testnet `api` service. The testnet web build at `testnet.eyeler.xyz` calls `https://api-production-9fcf.up.railway.app` directly. The mainnet app calls `https://api-mainnet-production-b042.up.railway.app` directly. Neither API hostname requires a GoDaddy record or a Vercel proxy. The operator added only the `testnet` CNAME to the isolated Vercel web project. On 2026-10-09, both GoDaddy nameservers, Google DNS and Cloudflare DNS returned the required target; Vercel verified it and issued a certificate; HTTPS returned 200 without redirect. Before the mainnet web switch, align the old testnet API's browser origin and Telegram links with `https://testnet.eyeler.xyz`, then verify its read-only routes and browser sign-in. Keep `api.eyeler.xyz` pointing to the testnet Railway service until a separate custom-domain migration is planned. Railway requires a new CNAME and verification TXT for each attached custom domain; never guess those records. Give the operator an exact table and wait for “done” before any later API vanity-domain move.

1. Confirm the existing signing-file backup. Build and install a signed Android APK; verify Digital Asset Links and the passkey prompt on the phone. Record the derived public Mera address; prepare only that address for the mainnet allowlist. A sign-in refusal can display and copy it before the backend cutover.
2. Provision separate mainnet PostgreSQL and the approved versioned Railway secret. Prove startup canary, context-denial and old-key rotation with nonproduction fixtures. For any public rollout, use AWS KMS and verify workload authentication and CloudTrail first. Run migrations against the new mainnet database only.
3. Bring up the mainnet API with execution disabled on a temporary domain. Verify `/health`, `/ready`, one replica, lock ownership, mainnet context, and per-user isolation. Do not use real orders as a smoke test.
4. Preserve the existing testnet operator service and database. The testnet web build is on `testnet.eyeler.xyz` and calls its Railway-provided HTTPS API domain directly. Verify the page's TESTNET label, CORS and sign-in before the mainnet web switch.
5. Build and publish mainnet web to `app.eyeler.xyz`; update GitHub auto-deploy target and verify its direct API URL, live build SHA, Asset Links HTTP headers, and Mera sign-in. The mainnet API still has execution disabled and openings off. Do not move `api.eyeler.xyz` during this direct-host cutover. Only then prepare a separately approved activation and user-performed bounty trade.
6. After the separate trading approval, enable openings and execution for the allowlisted account only. The operator, not deployment automation, confirms the bounty trade. Keep strategy LIVE disabled until its own later checkpoint.

For rollback, keep openings and execution disabled. Restore the prior web deployment or a clear maintenance page. Never point the mainnet app at the testnet operator database or its shared Perpl key. Retain every wrapping-key version needed by credential rows and backups; retain KMS decrypt access if KMS was used. The testnet service and domain remain available independently throughout rollback.

## Unverified external proof

The 2026-10-07 Asset Links 404 is historical. On 2026-10-09, `app.eyeler.xyz/.well-known/assetlinks.json` returned HTTP 200 `application/json` with both `handle_all_urls` and `get_login_creds` relations and the release certificate fingerprint after main merge `0830d19`. The signed local APK matches that fingerprint. The API remains on the default testnet operator configuration; no phone ceremony, mainnet activation, funding, enrollment or trade was performed by this integration. The allowlist-demo custody implementation is on `feat/eyeler-completion`, unmerged and undeployed. Follow the current [rollout](perpl-product-rollout.md) and [phone acceptance script](../product/phone-flow-test.md); the production configuration change still requires separate approval.
