# Analytics verification, 2026-10-07

All chain actions below were read-only. The local backfill used an in-memory PostgreSQL instance and bounded log ranges. No production database was changed.

## Recent mainnet sample

An initial three-chunk run started at block `111382224` while the head was `111382276`. It indexed 81 raw Exchange events, including 23 maker fills with derived notional `578.754014` AUSD. After the automatic seven-day start was implemented, a second three-chunk run located start block `109385344` at head `111387262`, then advanced to `109385404`. Its 60-block sample contained 169 raw events, 30 maker fills and `2,903.759788` AUSD of maker notional. Neither sample contained a deposit or liquidation event. That does not imply zero flows or liquidations in a full day or week. The dedicated worker continues the same 20-block chunks from its persisted checkpoint; the in-memory sample script stops after three chunks. A complete seven-day backfill still requires a persistent database and RPC environment configuration.

The public RPC returned HTTP 413 for a single genesis-to-head log request. Small 20-block ranges succeeded. A historical state read returned `RPC_-32602`; that failure concerns historical state, not historical event logs.

On 2026-10-08, an unsigned receipt query confirmed that Exchange creation transaction `0x22d1d74e137c3a82ac4b702fd90024811b184fcdcf8fd4d1473097b4d8a619f3` succeeded at block `54773010` and created the pinned Exchange address. A 1,000-block log query was rejected with RPC code `-32614`, message `eth_getLogs is limited to a 100 range`. A correctly bounded query for blocks `54773010`–`54773109` returned 21 logs in 1.678 seconds, including the creation transaction. This proves deployment-era log availability for that sample. It does not prove uninterrupted history or enough throughput for a complete replay.

The API now requires the verified deployment start, fresh included block timestamps and a caught-up checkpoint before claiming complete history. Regression tests reject partial performance totals, recent-start all-time claims, malformed recognized events and incomplete chart buckets. Fully covered chart buckets remain visible while the uncovered tail is null.

## Independent Perpl comparison

At `2026-10-07T17:05:52Z`, Perpl public context reported BTC 24h volume of `11,707,068.249030` AUSD. Summing 25 returned hourly candle volumes over the nearby request interval gave `11,728,293.792658` AUSD, a difference of `21,225.543628` AUSD (`0.1813%` of the context value). The sources use separately observed rolling windows. The exact cause of the difference is unverified. Do not use the candle sum as an exact reconciliation of the context snapshot.

A finalized public view call for an observed wallet returned balance `1,412,452.711716` AUSD and 11 open positions at block `111379026`. A separate 20-block Exchange log query returned 25 events, of which four were derived maker fills. These checks establish connectivity and decoder behavior for a small sample, not full historical completeness.

## Read-only comparison, 2026-10-08

At `2026-10-08T08:13:57.337Z`, unsigned Perpl context at block `111559471` reported BTC 24-hour volume `12,445,852.544367` AUSD. The separate request returned 24 hourly candles totaling `11,892,643.636495` AUSD, lower by `553,208.907872` AUSD. Request edges, response observations and rolling-window definitions differ; the exact source of this discrepancy is unverified. These figures are not a reconciliation or a complete archive proof.

The configured analytics RPC was absent, so the documented public Monad RPC was used for this recent read. Wallet view at head-minus-12 block `111559479` returned balance `1,405,007.410891` AUSD and 11 open positions. The unsigned 21-block range `111559462`–`111559482` returned 68 raw Exchange events and 18 derived maker fills, with no observed collateral flow event. This confirms a small recent sample only, not zero daily flows. No history was written to production, and no signed Perpl request, transaction or order was sent.

The new offline recovery test replays 1,000 **synthetic transport blocks** with the existing recorded logs, including a failed chunk, restart and 64-block rewind. It proves checkpoint and idempotency mechanics. Synthetic intervening headers/ranges do not establish continuous mainnet coverage, RPC throughput or a complete historical replay. Wrong-chain and mid-read boundary reorg failures were reproduced before adding chain checks and the final boundary reread.

## Finalized wallet and entry precision regressions, 2026-10-08

Fake-RPC tests now prove one finalized snapshot, address/ID roundtrips, matching account bitmaps, canonical hash rereads, source timestamps, cache freshness, context changes, wrong-chain/finality refusal and incomplete position coverage. SDK-derived bitmap vectors cover bank-one non-position bits, wrong membership and the 253 boundary. Equity includes position collateral; unavailable balance clamps at zero when order locks exceed account balance. Recorded market-100 short entry is `5.15296234588623046875`, preserving Q16 residue instead of truncating to `5.1529`. The recorded payload contains one position while its account bitmap contains eleven; whole-wallet equity is therefore unavailable. The Node-to-Flutter loopback test retains the exact entry and null equity.

These are offline correctness checks, not a new verified mainnet RPC snapshot. The old payload has no snapshot-block hash; its entry-block hash is not substituted for that missing proof. The finalized transport fixture uses synthetic headers. An initial red test accidentally constructed the real transport against `rpc.invalid` because the injected client did not exist yet; DNS failed with `ENOTFOUND`. The harness now forbids global fetch and asserts it was never called. No credentials or real venue action were involved.

## Latency

The offline cached `/markets` load check ran 400 requests at concurrency 20 with p95 `3.81 ms`, under the documented local target of 250 ms. It excludes network and cold database latency. Production p95 and a complete 7 to 30 day backfill are unverified.

## Perpl public daily-candle history, 2026-10-11

An unsigned read-only query fetched Perpl public context and 86400-second candles for all 11 markets listed at the time. After excluding the unfinished 2026-10-11 UTC candle, each listed market had consecutive daily candles through 2026-10-10 UTC with no missing day between its first and last returned candle. BTC and MON began 2026-02-12; the other listed markets began later. Summing each `v` once, as exact AUSD micros, produced **5,508,178,248.022144 AUSD** for 2026-02-12 through 2026-10-10 UTC. The completed UTC day, seven-day and 30-day candle sums were 8,485,786.847701, 98,365,691.140404 and 1,118,402,630.492947 AUSD respectively. These are observations, not frozen dashboard values.

The API contract says `v` is collateral-token volume. It does not explicitly establish whether Perpl counts one matched trade once or counts both sides. The calculation adds each market/day only once, but that does not settle the upstream convention. Current public context does not prove that no historical market was delisted. The dashboard therefore labels this as **Perpl API daily candles for currently listed markets** with a UTC cutoff, while indexed protocol-history coverage remains incomplete. Fees, flows and wallet history are not inferred from candles. The new gap and malformed-response tests make the all-window value unavailable if future public responses no longer satisfy these conditions.

At approximately `2026-10-11T05:20Z`, two immediate reads of those same completed days returned **5,508,183,609.449584** and **5,508,176,991.257766** AUSD. The public BTC candle for 2026-10-05 alternated between `9,961,212.607210` and `9,967,046.173553` AUSD across repeated requests, even while its response `at.b` stayed `110889630`. Hourly candles for that day alternated between the same two totals. This is an upstream inconsistency, not a rounding error or a missing day. The dashboard labels its figure as an observed **snapshot** and caches it for one hour; it must not be represented as a reconciled, immutable protocol total. A complete Exchange replay or a stable first-party aggregate is needed to close that proof gap.

The same validated daily-candle snapshot now supplies seven-day and 30-day summary volume when indexed coverage is incomplete. Both periods end at the last completed UTC midnight; `previous` covers the prior seven or 30 complete UTC days. Their source notes distinguish these periods from rolling 24-hour context volume. Tests prove exact-micro sums, staggered market launches, missing-candle refusal and exclusion of today's unfinished candle. The upstream historical revisions above also apply to these period totals.

## Mainnet data audit, 2026-10-12

Read-only source: direct **mainnet** Railway API `https://api-mainnet-production-b042.up.railway.app`, not the old `api.eyeler.xyz` testnet API. Window: 2026-09-12 00:00 through 2026-10-12 00:00 UTC, 30 complete days. The aggregate-only response fixture is [mainnet-2026-10-12.json](fixtures/mainnet-2026-10-12.json). No wallet address, transaction payload, token or private RPC URL is recorded.

| Metric | Live coverage and status | Evidence and limit |
| --- | --- | --- |
| Fees | **30/30 verified daily values**, `stale=false`; 114,796.887249 AUSD | Daily sum exactly equals 30-day rollup summary. This is an event-derived observation, not independent receipt-by-receipt reconciliation. |
| Volume | **30/30 daily candle values**, `stale=true` | Perpl API candles for currently listed markets; mutable upstream snapshot. No distinct-trader inference from candle counts. |
| Active users | **2/30 verified daily values**, `stale=true`, despite **30/30 covered days** | Only October 9 (287) and October 10 (267) were non-null. The other 28 days are unavailable because unresolved account owners invalidate distinct-owner counts. The 30-day summary is null. |
| Net flows time series | **0/30 verified daily values**, `stale=true`, `No indexed history` | Route reads only the incomplete raw indexer for this metric. The separate rollup-backed `/protocol/flows?window=30d` does have 30 daily buckets and reports 1,051,533.079255 deposits, 1,714,878.880500 withdrawals, net -663,345.801245 AUSD. |
| Revenue | **30/30 verified daily rollup values**, `stale=false`; 66,009.561647 AUSD | Daily sum exactly equals 30-day summary; source is position protocol-fee events, not gross trading fees. |
| Liquidations | **30/30 numeric daily notional points**, 815,722.453626 AUSD; summary count 538 | The liquidation endpoint's outer envelope still says `stale=true` and `No indexed history` because its raw-event list and summary use the incomplete raw indexer. Those 30 rollup points cannot prove the raw list or count event by event. One day has zero daily notional under complete rollup coverage. |

The pre-fix flow bucket response summed to only 21,442.865818 deposits and 67,399.736529 withdrawals, net -45,956.870711 AUSD, while its 30-day totals were the larger values above. `readCoveredRollups` selected every block-range row, but the route put them in a `Map` keyed by day and retained only the last row. This branch groups and sums rows by bucket start. It also routes daily `net_flows` through the covered rollups and exposes verified-value counts separately from covered-day counts. Focused database and route tests cover multiple ranges in one day, exact signed micros, incomplete-day nulls and unresolved-owner nulls. Production still serves the old code until a gated deployment.

`AccountCreated` provides the owner dimension; a bounded read-only HyperSync sample returned 10 owners in blocks 54,773,010–55,273,010 and 9 in blocks 105,000,000–105,500,000. The worker currently resets its owner cursor to creation block on each process start and does not retain resolved owners for newly saved rollup ranges. Migration 037 and the branch worker persist only account-to-owner mapping and scan progress, then reuse that mapping as 35-day buckets turn over. This is a credible cause of the incomplete owner values, but production owner counts, exact cursor position and migration 037 state could not be read: local `railway run` could not resolve the private Postgres hostname (`ENOTFOUND`), and Railway SSH reported no configured SSH key. The previous deployment logged `migration applied`; that message does not prove which tables are present. Do not claim active users complete until production returns 30/30 non-null values after deployment and owner scan.

The 35-day retention limit still applies to rollup buckets, actor rows and block coverage. The new owner dimension and scan cursor persist beyond 35 days because an account can trade in the current window after its `AccountCreated` event has aged out. They store no fills, event payloads or transaction identities. This is the documented retention exception needed to verify current-window distinct owners.

An attempted full creation-to-current owner-source audit was rejected by automatic approval review because it exceeded the requested 30-day scope without enough documented need. It was stopped; no broad scan completed. The two bounded source samples above completed before that attempt. A sampled owner source does not prove every historical interval.

The recorded public-wallet fixture address was used only in read-only requests. Both `/wallets/:address/trades?limit=100` and `/performance` timed out after 90 seconds. Last-30-day trade count, realized PnL, performance and specific unavailable reasons remain **unverified live**. The code and focused tests preserve null for unproved account enumeration, ambiguous fills, unsupported settlements and missing starting equity; no live wallet total is claimed.

`/ready` returned `ready=true`, `lockOwned=true`, `venueReady=true`. Railway's active mainnet deployment still served main commit `9cc4ea1`; no trading variable, database row or deployment was changed by this audit. Railway current-period usage was **$1.381371** and estimated bill **$1.426018** at the read. The period ends 2026-10-12 UTC. The older documented $4.41 credit would imply about $3.03 remaining if unchanged, but current credit and next-period billing were not verified, so a reliable runway cannot be stated.

Signed-out visual verification at 360 and 1280 px remains blocked: the Computer Use inventory exposed no browser or app surface, and both Chrome and in-app browser creation reported unavailable. The live API values and metadata above were verified directly; they are not a visual dashboard proof. No 360/1280 screenshot was produced.
