# Mainnet strategy evidence

The public system link is `https://app.eyeler.xyz`. A source branch, an HTTP 200 response, a successful manual trade, or a simulated result does not prove that the candidate performed automatic mainnet trading. Publish a reviewed run only after the candidate is separately deployed and its real activity is verified. This implementation work does not deploy or place trades.

## Owner-scoped export

The report requires an exact UTC window, an authenticated owner ID and an environment. A read-only database connection is sufficient. It excludes another owner's strategies and the other environment, including when a specific strategy ID is requested.

```powershell
node --import tsx server/src/infrastructure/strategies/report-cli.ts --from 2026-10-13T00:00:00Z --to 2026-10-13T01:00:00Z --user OWNER_UUID --environment mainnet --strategy STRATEGY_UUID
```

The example times and IDs must be replaced with the actual run. Configure the read-only database connection privately. Do not publish database credentials, API keys, session tokens, private keys or passkey material. The exported JSON contains strategy/order IDs, public account/market IDs and transaction references; review those details before sharing.

The reusable call is:

```ts
const report = await buildStrategyRunReport(pool, fromUTC, toUTC, strategyId, {
  userId: authenticatedSession.userId,
  environment,
})
```

The report permits at most 31 days, 100 strategies and 500 records per evidence collection. Larger exports fail with `STRATEGY_REPORT_LIMIT_EXCEEDED` instead of reporting truncated counts. Use narrower windows or one strategy at a time.

## Evidence semantics

- **PAPER:** PnL is the exact decimal difference between the first and last recorded simulated equity observations in the window. Fewer than two distinct observations means unavailable. The simulation's underlying financial model remains a simulation.
- **LIVE commands:** `STORED_COMMAND_ADMISSION` revalidates the saved proof against the immutable order, units, account, request, deadline and placement identity. It proves a stored command admission, not a fill, profitability or a fresh independent receipt check. The requested execution deadline is never displayed as a confirmed execution block.
- **LIVE fills:** `STORED_VERIFIED_FILL` comes only from `strategy_verified_fills`, with its proof fingerprint and immutable placement identity checked again. Legacy `strategy_fills` rows and arbitrary non-simulated transaction hashes do not qualify. Gross fees already contain the builder component; do not add builder fees again.
- **Automation:** Only persisted `execution_origin='AUTOMATION'` qualifies. Internal or older unrecorded commands are explicitly unattributed. Mainnet counts additionally require both `environment='mainnet'` and `mode='LIVE'`. Testnet and PAPER never count as mainnet automation.
- **Time:** Command windows use submission time, or creation time for an unsent command. Verified fill windows use ledger recording time because the existing ledger does not store the chain event timestamp. A delayed ingestion can appear after the actual fill. Unresolved order counts cover commands created or submitted within the window, using their status at export.
- **Coverage:** Recorded minute counts describe observed strategy ticks, not continuous process or venue uptime. Current database state is not a historical deployment or consent attestation.
- **Profitability:** LIVE net PnL and funding totals remain unavailable until complete attributed funding, settlement, gas and capital-flow coverage is established. A fill, a successful command, wallet balance or mark-to-market gain does not establish net profit. The report never replaces missing costs with zero.

## Explicit public artifact

The report is private until its authenticated owner reviews publication. The artifact helper performs no network or publication operation:

```ts
const artifact = createStrategyEvidencePublication(report, {
  ownerReviewed: true,
  systemUrl: 'https://app.eyeler.xyz',
  candidateSha: deployedCandidateSha,
  publishedAt: new Date().toISOString(),
})
```

The helper whitelists report fields and excludes API key, user ID, connection ID, wallet address and session fields. It rejects HTTP URLs and URLs containing credentials, query strings or fragments. The HTTP publisher supplies the SHA from server `SOURCE_VERSION`, `GITHUB_SHA` or `RAILWAY_GIT_COMMIT_SHA`; it refuses publication when none contains a full 40-character lowercase Git SHA. Client-supplied report or SHA fields are rejected. The SHA remains a source label, not independent deployment attestation.

### Publication controls and public page

- `POST /strategies/evidence-publications`, authenticated owner only: `{ "from": "actual UTC start", "to": "actual UTC end", "strategyId": "optional owned UUID", "ownerReviewed": true }`. The server rebuilds the actual owned report and saves a sanitized immutable artifact. Response: `201 { id, path, artifact }`.
- `GET /strategies/evidence-publications?strategyId=UUID`, authenticated owner only: active publication list `{ id, path, createdAt }`. The strategy filter is optional. This restores revocation controls after refreshing the app.
- `GET /evidence/:id`, public: a compact dark HTML evidence page. `Accept: application/json` returns the same stored artifact. This route reads only the saved publication; it never queries live private strategies or submits trades. PAPER and testnet remain labeled; zero qualifying records show “No mainnet automation evidence in this report.”
- `DELETE /strategies/evidence-publications/:id`, authenticated publication owner only: revokes public access. Revocation is idempotent and cannot be undone. The owner can publish a new reviewed snapshot if needed.

Resolve the returned path against the deployed **API origin**, because the HTML page is served by the backend. Its “Open trading system” link goes to the configured HTTPS app URL, defaulting to `https://app.eyeler.xyz`. The ordinary app link remains the system link requested by the submission form; the separate evidence link helps judges inspect a reviewed run without signing in.

Public responses use `Cache-Control: no-store`, a script-free Content Security Policy, no-referrer, nosniff and noindex. Revoked or unknown publications return 404. Private publication controls remain behind the session gate; only the exact registered GET evidence route is public.

### Schema compatibility and rollback

Migration `040_strategy_public_evidence.sql` adds a separate publication table, index and immutable-artifact trigger. It preserves all current strategies, orders, accounting rows and existing readers. It can safely reapply. A mixed deployment with the older server cannot create or read publications, but still reads its strategy data unchanged.

Rollback the application by removing the new route registration while retaining the additive table; this preserves reviewed artifacts and revocations for a later roll-forward. Removing stored publications or dropping this table destroys publication history and requires a separately approved database change. No schema contraction or production migration occurs during local implementation.

Before claiming real automation, independently verify the actual network, canonical successful receipt, configured Exchange destination, exact account/request and relevant operation or fill logs. Retain the deployed candidate SHA and before/after account exposure. The report deliberately sets `independentlyReverified=false`; stored proof is not a substitute for that final check. Explorer links use MonadVision's mainnet or testnet origin, as listed in [Monad's official explorer documentation](https://docs.monad.xyz/tooling-and-infra/block-explorers).

No real automatic mainnet run or profitable result is created by these local tests. Synthetic receipts and fake transports are test evidence only. The owner supplies the final video; the submission still requires a working candidate and genuine demonstrated activity.
