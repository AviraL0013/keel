# Perpl product rollout and rollback

This runbook is preparation only. Agora readiness and guarded Perpl product code are merged on main `0830d19`; production remains testnet operator mode because feature variables are absent. LIVE strategy accounting/controller/cancellation and complete analytics coverage remain unfinished; flags cannot substitute for that work. Do not execute a mainnet rollout until release blockers and operator checkpoints are satisfied.

## Checkpoints and release blockers

1. Finish exact account/perpetual attribution, verified funding/settlement, safe transmitted-capital release, owned cancellation, restart and lease handover. Keep LIVE unmounted until integrated fake-engine tests prove these paths.
2. Finish required mobile views and recorded screenshots with matching Linux Flutter evidence. Verify the exact candidate's five CI jobs; an older green run is insufficient. GitHub access returned 403 during this task, so newer runs are unverified.
3. Complete the [phone script](../product/phone-flow-test.md) through the read-only wallet checkpoint. Do not fund, activate or trade as a smoke test.
4. For the allowlisted team demo, use the explicit Railway-secret envelope mode after the phone and configuration checkpoint. No AWS KMS metadata is needed now. Public access still requires KMS. Never request secret values in chat.
5. Prove the Railway key startup canary, denied-context decrypt and old-version restore with nonproduction fixtures. Retain old key versions for rows and backups. No real Railway variable change is authorized solely by local tests.
6. **Checkpoint B:** obtain explicit mainnet configuration/deploy approval for a concrete SHA and reviewed settings. Agora and guarded Perpl code have already merged. Re-run every gate and verify CI for further completion merges; use `--no-ff`, never force-push main.
7. **Checkpoint C:** obtain wallet/account, capital and loss limits plus separate explicit real-trading permission. Configure and review limits without sending orders. No automated opening or bounty trade is permitted before that approval.

Agora readiness `b3ad5bb` merged as `c599598`; Perpl product merged as `0830d19`. Main CI passed all five validation jobs and deploy_web for both merges. Production configuration remains separate from code deployment. Fetch again before any later merge and preserve both sides' behavior.

## Backend variable names

Values belong only in the host's secure settings. Keep production secrets out of builds, documentation artifacts and chat. Do not copy testnet/operator credentials into mainnet per-user deployment.

| Group                                             | Names                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Service/database/session                          | `EYELER_ENV`, `PORT`, `DATABASE_URL`, `SESSION_SECRET`, `CORS_ORIGIN`, `EYELER_APP_URL`                                                                                                                            |
| Account/access                                    | `EYELER_PERPL_ACCOUNT_MODE`, `EYELER_ACCESS_MODE`, `EYELER_ALLOWED_WALLETS`, `MONAD_WALLET_ADDRESS`                                                                                                                |
| Venue/network                                     | `PERPL_REST_URL`, `PERPL_WS_URL`, `PERPL_CHAIN_ID`, `MONAD_RPC_URL`, `MONAD_CHAIN_ID`, `AUSD_TOKEN_ADDRESS`                                                                                                        |
| Enrollment                                        | `PERPL_ENROLLMENT_ORIGIN`, `EYELER_KEY_TTL_DAYS`, `EYELER_EGRESS_CIDRS`, `EYELER_BUILDER_ID`, `EYELER_MAX_BUILDER_FEE_PER_100K`                                                                                    |
| Credential custody                                | `EYELER_KEY_CUSTODY`, `EYELER_DEMO_CUSTODY_KEYS`, `EYELER_DEMO_CUSTODY_ACTIVE_VERSION`; or KMS: `AWS_REGION`, `EYELER_KMS_KEY_ARN`, `EYELER_KMS_DECRYPT_KEY_ARNS`                                                  |
| Web-identity access, only when actually supported | `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`                                                                                                                                                                      |
| Execution controls                                | `EYELER_EXECUTION_DISABLED`, `EYELER_OPENING_ENABLED`, `EYELER_STRATEGIES_ENABLED`, `EYELER_STRATEGIES_LIVE_ENABLED`, `EYELER_TEST_VENUE`                                                                          |
| Freshness/recovery                                | `EYELER_OPENING_PREVIEW_TTL_MS`, `EYELER_ORDER_VERIFY_TIMEOUT_MS`, `EYELER_SAFE_MODE_RESUME_TICKS`, `EYELER_TICK_STALE_MS`                                                                                         |
| Analytics                                         | `EYELER_ANALYTICS_ENABLED`, `EYELER_ANALYTICS_RPC_URL`, `EYELER_ANALYTICS_START_BLOCK`, `ANALYTICS_PERPL_API_URL`, `ANALYTICS_CONFIRMATIONS`, `ANALYTICS_CHUNK_SIZE`, `ANALYTICS_POLL_MS`, `ANALYTICS_CORS_ORIGIN` |
| Linked Telegram                                   | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`                                                                                                                       |
| Optional Agora/metrics                            | `AGORA_API_URL`, `AGORA_API_KEY`, `AGORA_METRICS_ENABLED`                                                                                                                                                          |
| Snapshot retention                                | `EYELER_SNAPSHOT_FULL_HOURS`, `EYELER_SNAPSHOT_ARCHIVE_DAYS`, `EYELER_SNAPSHOT_RETENTION_BATCH_SIZE`, `EYELER_SNAPSHOT_RETENTION_INTERVAL_MS`                                                                      |

Use canonical `EYELER_` names consistently. Some legacy `KEEL_` aliases remain supported; do not set conflicting aliases. `EYELER_PERPL_CONNECTION_ID` is an internal server-scoping value, not a user-selected shared connection. Shared `PERPL_API_KEY`, `PERPL_API_KEY_SECRET` and `PERPL_ACCOUNT_ID` are operator-only and must be absent in mainnet per-user mode.

Mainnet per-user `railway-allowlist-demo` requires explicit `EYELER_ACCESS_MODE=allowlist`, a nonempty team-wallet allowlist and a successful envelope startup probe. Public mode or operator mode cannot use it; public access requires AWS KMS. Development custody variables `EYELER_KEY_ENCRYPTION_KEY`/`KEEL_KEY_ENCRYPTION_KEY` are forbidden on deployed networks. Deployed testnet may use its separate versioned `railway-testnet` custody with `EYELER_TESTNET_CUSTODY_KEYS` and `EYELER_TESTNET_CUSTODY_ACTIVE_VERSION`. See [mainnet plan](mainnet-bounty.md), [KMS](aws-kms.md) and [credentials](credentials.md).

## Public build definitions and Vercel

Public Flutter definitions: `EYELER_API_URL`, `EYELER_DEPLOYMENT`, `EYELER_CHAIN_ID`, `EYELER_CHAIN_NAME`, `EYELER_MONAD_RPC_URL`, `EYELER_MONAD_EXPLORER_URL`, `EYELER_NATIVE_CURRENCY_NAME`, `EYELER_NATIVE_CURRENCY_SYMBOL`, `EYELER_MERA_RP_ID`, `EYELER_BUILD_SHA`. `EYELER_ANALYTICS_FIXTURE` is test-only and must not produce a published demo pretending to show live data. No KMS, database or Perpl credential belongs in Dart defines.

Keep `app.eyeler.xyz` as the approved mainnet enrollment origin/RP ID. Move the existing testnet operator frontend to `testnet.eyeler.xyz` with its matching API, without repurposing its database. Review the GitHub deployment target and Vercel project build/output configuration during approved cutover. CLI deployments and Git-triggered deployments are different evidence; inspect the actual alias deployment ID and SHA.

## Service and migration order

1. Review backup/restore, retained wrapping-key versions and pending orders before any deployment. Preserve the testnet service/database and its operator allowlist.
2. Provision a separate mainnet per-user API/database with allowlist access. Keep execution, openings and LIVE strategies disabled. Migrations run from the exact candidate image. Never attach mainnet to the operator testnet database.
3. Run the additive migrations against a nonproduction schema copy twice first, with populated legacy fixtures. The local fixture has passed the full current set twice, including 032/033; this does not prove a production backup or deploy migration.
4. Run analytics as its own Railway service with its own read-only chain source and database permissions sufficient for analytics tables/checkpoints. It never acquires the trading lease. Start at verified Exchange creation block `54773010` only if archive logs and throughput are available; otherwise keep recent-window `Since <date>` labels and unavailable metrics. Confirmation depth is not consensus finality.
5. Maintain exactly one execution replica. Preserve shared request-ID/account locks. With LIVE strategies later enabled, a new owner must reconcile the previous owner's orders before trading. This handover remains an implementation blocker; do not assume the existing Book handover proves it.
6. Verify migration logs, backend serving SHA, `/ready` HTTP 200, `ready`, `venueReady`, `lockOwned`, `lastTickAgeMs`, replica count and lease handover. Readiness with execution disabled is not permission to trade.
7. Publish the matching frontend only after backend identity and configuration are proved. Verify live build SHA, direct Asset Links HTTP/JSON/no-redirect/package/fingerprint/both relations, Google checker and user-operated sign-in. Verify Telegram through the linked user's chat, never a guessed chat ID.
8. Enable read-only analytics separately from execution. Keep missing/incomplete coverage visible. LIVE strategy enablement requires the completed controller, both flags, durable confirmation, owned account, custody, fresh state and loss/capital limits on every send. No flag activates unfinished code.

## Rollback

Stop new submissions first. Do not discard pending `UNKNOWN`/`PARTIAL` rows, reset request IDs, release ambiguous allocations or cancel another user's orders. A disabled execution flag blocks new sends but does not prove resting orders are gone. Do not stop a LIVE deployment until its owned orders are reconciled/canceled by a proved cleanup path; this is why LIVE remains blocked today.

Restore the prior compatible API image and frontend alias as one reviewed environment pair. Keep additive migrations, execution history and every Railway wrapping-key version or KMS decrypt key needed by retained rows/backups. Never point mainnet sessions to the shared testnet account. If a schema rollback requires a backup restore, review unresolved venue outcomes first; database restoration cannot undo chain activity. Resume only after fresh state, one lease owner, compatible configuration and human approval.

## What remains unverified

Full backfill and archive throughput; physical phone/passkey flow; allowlist-demo key creation and Railway configuration; separate mainnet service/database; linked Telegram delivery; LIVE fills and exact PnL. The `0830d19` code-only deploy passed CI and `/ready` with one replica and lock held; it did not switch environment or enable feature flags.
