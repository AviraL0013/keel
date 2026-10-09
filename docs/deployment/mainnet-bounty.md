# Mera / Perpl mainnet bounty rollout

This is a deployment plan, not an authorization to send a transaction. The current production web app and Railway `api` remain the testnet operator deployment until cutover. Do not apply this plan before the release branch passes CI, the release-signed Android app is tested on a phone, the signing files are backed up, and AWS KMS workload authentication works from Railway.

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

| Variable                                                   | Required setting                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `EYELER_ENV`                                               | `mainnet`                                                                                                 |
| `EYELER_PERPL_ACCOUNT_MODE`                                | `per-user`                                                                                                |
| `EYELER_ACCESS_MODE`                                       | `allowlist`                                                                                               |
| `EYELER_ALLOWED_WALLETS`                                   | Mera wallet address after phone creation, plus explicitly approved team wallets only                      |
| `EYELER_OPENING_ENABLED`                                   | `true` only after `feat/opening-trades` is integrated, reviewed, and its fake-venue gates pass            |
| `EYELER_EXECUTION_DISABLED`                                | Keep `true` until KMS, per-user enrollment, and readiness checks pass; then deliberate cutover to `false` |
| `DATABASE_URL`                                             | New mainnet PostgreSQL database; never the testnet database                                               |
| `SESSION_SECRET`                                           | New independent mainnet secret                                                                            |
| `CORS_ORIGIN`, `EYELER_APP_URL`, `PERPL_ENROLLMENT_ORIGIN` | `https://app.eyeler.xyz`                                                                                  |
| `PERPL_REST_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID`         | `https://app.perpl.xyz/api`, `wss://app.perpl.xyz`, `143`                                                 |
| `EYELER_BUILDER_ID`, `EYELER_MAX_BUILDER_FEE_PER_100K`     | `25`, `0`                                                                                                 |
| `MONAD_RPC_URL`, `MONAD_CHAIN_ID`, `AUSD_TOKEN_ADDRESS`    | `https://rpc.monad.xyz`, `143`, mainnet AUSD address above                                                |
| `EYELER_KEY_CUSTODY`, `AWS_REGION`, `EYELER_KMS_KEY_ARN`   | `aws-kms`, key region, immutable mainnet key ARN                                                          |
| `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`              | Only if Railway can supply an actual workload identity; role ARN alone is insufficient                    |
| `EYELER_KMS_DECRYPT_KEY_ARNS`                              | Optional old key ARNs during controlled rotation                                                          |
| `TELEGRAM_BOT_TOKEN`                                       | Optional; existing bot credential managed only in Railway                                                 |
| `EYELER_APP_URL`                                           | Also used for Telegram Book links; must point to mainnet app                                              |

Do not set shared `PERPL_API_KEY`, `PERPL_API_KEY_SECRET`, or `PERPL_ACCOUNT_ID` on mainnet. Do not set `EYELER_KEY_ENCRYPTION_KEY` or `KEEL_KEY_ENCRYPTION_KEY`. The mainnet process refuses startup without AWS KMS. Follow [AWS KMS setup](aws-kms.md) for key policy, workload identity, startup probe, and audit checks. The operator has not provided an AWS key or role yet; a fake KMS test is not deployment evidence.

## Web and Android

`scripts/deploy/build-web.sh mainnet` builds the mainnet Flutter web profile for `app.eyeler.xyz`. Its build defines are `EYELER_API_URL=https://api.eyeler.xyz`, `EYELER_DEPLOYMENT=mainnet`, `EYELER_CHAIN_ID=143`, `EYELER_CHAIN_NAME=Monad`, `EYELER_MONAD_RPC_URL=https://rpc.monad.xyz`, `EYELER_MONAD_EXPLORER_URL=https://monadscan.com`, `EYELER_NATIVE_CURRENCY_NAME=Monad`, `EYELER_NATIVE_CURRENCY_SYMBOL=MON`, `EYELER_MERA_RP_ID=app.eyeler.xyz`, and `EYELER_BUILD_SHA=<commit>`.

The current GitHub `deploy_web` job still builds testnet for `app.eyeler.xyz`; change its live target to `mainnet` only during the reviewed cutover. Configure Vercel to serve `/.well-known/assetlinks.json` directly from the app build with HTTP 200, JSON content type, and no redirect. Verify the SHA-256 fingerprint against the backed-up release keystore before publishing. Android release signing must read keystore path and passwords from local files or environment only. Never commit the keystore, passwords, or `key.properties`.

## Cutover order and rollback

1. Back up signing keystore and password file. Build and install a signed Android APK; verify Digital Asset Links and passkey prompt on the phone. Record the derived Mera address; add only that address to the mainnet allowlist.
2. Provision mainnet PostgreSQL and AWS KMS. Prove Railway workload authentication, startup canary, decrypt-denial behavior, and CloudTrail delivery with nonproduction fixtures. Run migrations against the new mainnet database only.
3. Bring up the mainnet API with execution disabled on a temporary domain. Verify `/health`, `/ready`, one replica, lock ownership, mainnet context, and per-user isolation. Do not use real orders as a smoke test.
4. Preserve the testnet operator service on `api.testnet.eyeler.xyz` and move the current testnet web build to `testnet.eyeler.xyz`. Keep its existing database and credentials with that service. Confirm both are explicitly labeled TESTNET before switching `api.eyeler.xyz`.
5. Switch `api.eyeler.xyz` to the mainnet service. Build and publish mainnet web to `app.eyeler.xyz`; update GitHub auto-deploy target and Vercel aliases. Check live build SHA, assetlinks HTTP headers, and Mera sign-in. Only then allow deliberate activation and one operator-performed bounty trade in the app.
6. Enable openings only after the reviewed opening-trades branch is included and all gates pass. The operator, not deployment automation, confirms the bounty trade.

For rollback, disable openings and execution first. Restore the prior web deployment or a clear maintenance page. Repoint `api.eyeler.xyz` only to a compatible mainnet API/database pair; never attach mainnet users to the testnet operator database or its shared Perpl key. Keep KMS decrypt access for all retained credential rows and backups. The testnet service and domain remain available independently throughout rollback.

## Unverified external proof

The 2026-10-07 Asset Links 404 is historical. On 2026-10-09, `app.eyeler.xyz/.well-known/assetlinks.json` returned HTTP 200 `application/json` with both `handle_all_urls` and `get_login_creds` relations and the release certificate fingerprint after main merge `c599598`. The signed local APK matches that fingerprint. The API remains on the default testnet operator configuration; no phone ceremony, mainnet activation, funding, enrollment or trade was performed by this integration. Follow the current [rollout](perpl-product-rollout.md) and [phone acceptance script](../product/phone-flow-test.md). The separate allowlist-demo custody decision still needs implementation and approval before any mainnet configuration change.
