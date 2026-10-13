# Analytics operations

Analytics v1 is public and read-only. `EYELER_ANALYTICS_ENABLED` defaults to false and mounts `/analytics/v1` when enabled. Analytics workers do not sign, submit transactions, or acquire the trading lease. See [API contract](../api/analytics-v1.md), [metrics](metrics.md), and [dated evidence](verification.md).

## Sources and configuration

- Unsigned Perpl REST supplies context, market observations, candles, and funding. Signed account history is not a source for arbitrary public-wallet history.
- Monad mainnet Exchange logs supply indexed events. The official SDK event ABI has pinned SHA-256 `766fc81326bdf27f243ca582f65c3e2ff72bc639d88674876697a63ae1c47cb3`.
- Wallet views and event-block ownership checks use finalized RPC blocks, account/address roundtrips, and hash rereads. They trust the provider, not receipt-trie or storage proofs.

Keep backend secrets out of logs and Flutter builds, including private RPC URLs, database connections, and HyperSync tokens.

Apply migrations against `DATABASE_URL` before workers. `EYELER_ANALYTICS_RPC_URL` optionally overrides the public Monad RPC. `EYELER_ANALYTICS_START_BLOCK` defaults to an approximately seven-day start; full replay starts at Exchange creation block `54773010`. `ANALYTICS_PERPL_API_URL` defaults to `https://app.perpl.xyz/api`.

Raw-indexer defaults: `ANALYTICS_CONFIRMATIONS=12` (range 1-256), `ANALYTICS_CHUNK_SIZE=20` (maximum 100 blocks), and `ANALYTICS_POLL_MS=3000`. Confirmation depth is not consensus finality. `ANALYTICS_CORS_ORIGIN` allows an optional exact HTTPS origin; `https://app.eyeler.xyz` is allowed. `EYELER_HYPERSYNC_TOKEN` is a backend-only bearer token for optional readers.

## Raw history indexer

Run `npm run analytics:indexer` separately from the API. Advisory lock `(143, 20261007)` prevents duplicate raw indexers. Each chunk checks chain 143, validates logs/headers, rereads its boundary hash, and commits raw/derived rows with the checkpoint atomically. Exact duplicates are idempotent; conflicting, removed, or out-of-range logs and incomplete header batches fail closed.

Header batches are capped at 20. Log ranges grow after three successful chunks, up to 100 blocks; HTTP 413 or RPC `-32614` halves the range. HTTP 401/403 stops the worker. Other transient failures use backoff up to 60 seconds, with 100 ms pacing between successful chunks.

A changed checkpoint hash rewinds 64 blocks, bounded by the stored start, and rebuilds derived data. An earlier start also rewinds. Both clear completion. Migration 035 invalidates premature `history_verified` claims. Completion requires the deployment start, creation-log anchor, stored hash/time, and continuous replay to a fresh confirmation boundary. Until proved, expose `Since YYYY-MM-DD` and incomplete coverage. Configuration or checkpoint write time alone cannot prove `All time`.

## Protocol rollups and snapshots

`EYELER_ANALYTICS_ROLLUPS_ENABLED` defaults off. With the flag and HyperSync token configured, the mainnet API process runs a separate rollup worker using advisory lock `(143, 20261011)` and a dedicated two-connection pool. It reads bounded tail/backfill ranges and owner slices, with a 12-second idle cadence and a 12-block confirmation margin.

Migration 021 stores hourly/daily aggregates, account membership, and block coverage for 35 days, without raw payloads or transaction identities. Migration 037 retains only owner mapping and scan cursor beyond that window for restart-safe resolution. Unresolved owners keep user counts null; `activeAccounts` is diagnostic. Creation mapping never substitutes for event-block trade ownership.

Readers require contiguous UTC-bucket coverage. Gaps are null; zero requires complete coverage. Fees count maker/taker fees once; protocol-fee settlements determine revenue; external deposits/withdrawals determine net flows. Opening activity skew differs from open-interest skew. This store proves neither all-time history nor a previous 30-day comparison.

`EYELER_ANALYTICS_SNAPSHOTS_ENABLED` defaults off. OI history consists of actual Perpl context observations; TVL snapshots use the finalized AUSD balance of the pinned Exchange. History starts with collection, with no invented earlier values. Daily stock values use the last hourly observation, not a sum. TVL is unavailable after two hours without a fresh observation.

## Wallet activity and history limits

`GET /analytics/v1/wallets/:address/activity` counts distinct currently linked accounts active in each of the last 30 completed UTC days. It counts settled maker fills or non-liquidation position actions. This proves neither historical address ownership, trade count, nor realized PnL. `activeDays` remains null until all 30 days are covered. A disabled or failed store returns an unavailable reason without blocking the current profile.

Trade readers support verified maker rows and strict receipt-correlated taker attribution. Each displayed trade requires ownership proof at its canonical event block. Taker events lack account/market IDs; unsupported, ambiguous, or incompletely reconstructed settlements remain unresolved. Creation-address candidates can miss transferred accounts, so visible rows do not prove a complete wallet total.

`EYELER_ANALYTICS_WALLET_ONDEMAND_ENABLED` defaults off. Optional HyperSync scans cover a bounded last-30-day range, cache for 60 seconds, and fail on page/log caps. Incomplete account enumeration keeps aggregate performance unavailable. Whole-window scans per wallet page are not viable at measured source limits.

`EYELER_ANALYTICS_WALLET_LEDGER_ENABLED` also defaults off. Migration 038 is additive. With the flag off, the rollup worker retains its original selector and writes no wallet-ledger rows. When enabled, it stores compact position events from bounded rollup reads and backfills aggregate-only ranges newest first. Wallet-indexed coverage/events commit atomically against the same canonical end-block hash; pruning 35-day coverage cascades to its ledger events.

Keep the ledger off until a representative range is written to a bounded staging database, PostgreSQL bytes and query latency are measured, and projected 30-day storage/cost fits the available budget. Exact production growth and remaining trial credit are unmeasured. Trade pages cap owner proofs at five; gross-settlement attempts cap at 20 events. These limits can leave large wallets unavailable.

Gross settlement is price PnL plus funding before fees. It requires complete window coverage, owner scan, supported settlements, and exact-block owner proofs. Net PnL, win rate, full equity curves, drawdown, and liquidation thresholds remain unavailable without their separate reconstruction/formula proofs. Unknown values remain null.

## Dashboard and local verification

The dashboard at `https://app.eyeler.xyz/#/analytics` was observed deployed in October 2026; [verification](verification.md) records limits. Its GET-only transport has no session-token access. Mainnet labels are independent of trading. Missing API data renders unavailable states; fixtures are test-only.

Public routes allow 60 requests/minute per IP. Live/wallet caches last 15 seconds; series/funding caches last 60 seconds. Pagination preserves `(block, transaction index, log index)` order. Freshness and coverage labels remain visible.

Offline cached latency target: p95 under 250 ms, excluding internet and cold database latency. Run `npx tsx scripts/analytics-load.ts`. For recorded Node-to-Flutter loopback proof, install both SDKs and run `flutter test tool/analytics_server_contract_test.dart --reporter expanded` from `apps/mobile`. This temporary replay uses recorded fixtures, starts no trading worker, and cannot establish fresh balances or complete history.
