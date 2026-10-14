# Analytics verification evidence

These read-only observations date from October 7-13, 2026. Cleanup adds no live verification. Probes sent no orders and changed no production rows. See [operations](operations.md) and [metrics](metrics.md).

## Exchange history and source bounds

On October 8, an unsigned receipt confirmed Exchange creation transaction `0x22d1d74e137c3a82ac4b702fd90024811b184fcdcf8fd4d1473097b4d8a619f3` at block `54773010`. Public Monad RPC rejected 1,000-block log queries with `-32614`; its maximum was 100. A deployment-era sample returned 21 logs. Historical state and log availability differ.

On October 11, selected-signature 100-block queries at `54773010`, `70000000`, `90000000`, and `112396000` matched split 20-block reads. Creation logs included `Upgraded`, `ExchangeInitialized`, and `Initialized`. Header batches above 20 produced `-32007`. Samples do not prove continuous full history.

Local replay from `90000000`: 2,020 consecutive blocks, 9,635 logs, 107.190 seconds, 18.85 blocks/s including pacing/retries. Sample-based estimates were 35.4 days to a fixed head or 40.8 days with head growth. Complete replay and production throughput remain unverified.

## Public candles, October 11

The 11 then-listed markets had consecutive daily candles through October 10; BTC/MON began February 12. One sum was **5,508,178,248.022144 AUSD**. Same-cutoff repeats returned **5,508,183,609.449584** and **5,508,176,991.257766 AUSD**. Historical BTC volume changed at the same response block.

These mutable snapshots cover current listings; delisted markets and fill-side semantics remain unknown. Seven-day/30-day comparisons end at UTC midnight, unlike rolling context. Candles prove no fees, revenue, flows, traders, or wallet history. Gaps/malformed candles leave totals unavailable.

## Protocol observations, October 12-13

The October 12 audit used the direct mainnet Railway API, not old testnet `api.eyeler.xyz`. Window: September 12 00:00 through October 12 00:00 UTC. The original aggregate-only source export remains in Git history.

- Fees: 30/30 daily values, 114,796.887249 AUSD; revenue: 30/30, 66,009.561647 AUSD. Both matched rollup summaries, without independent receipt reconciliation.
- Volume: 30/30 candle values, initially stale and later observed fresh; mutable current-listing snapshot.
- Active users: 2/30 verified values despite 30/30 covered days. Unresolved owners kept other values and summary null.
- Daily net flows: 0/30 verified values. Separate totals were deposits 1,051,533.079255, withdrawals 1,714,878.880500, net -663,345.801245 AUSD.
- Liquidations: 30 numeric daily points totaling 815,722.453626 AUSD; reported count 538. The outer raw-indexer envelope remained incomplete/stale; list/count lacked independent event-by-event verification.

A day-keyed map retained only the last block-range row, causing incorrect flow buckets. The fix sums daily ranges, uses rollups for net flows, and separates verified values from covered days. Migration 037 persists owner mapping/cursor. Historical regressions and CI passed; no fresh deployment check is claimed.

An authorized owner scan covered 117 contiguous slices from `54773010` through `112829267`: 5,470 unique account IDs in 791.996 seconds. It retained no addresses/raw logs. This proves successful source responses, not exhaustive ownership or production application.

On **October 13**, a later read returned **30/30 verified active-user daily values**. This differs from the October 12 fixture's 2/30 result. It does not independently prove every historical owner or account transfer.

Archived signed-out captures at 360 px and 1280 px prove a deployed overview rendered October 12. They show earlier partial users and old flow aggregation, not corrected flows or every tab/interaction.

## HyperSync capacity and wallet limits

October 11 selected-metric benchmark: 10,793,721 logs, 6,359 pages, 30 days, 232.346 seconds, 12 readers. It measures fetch/parsing only. An all-signature attempt exhausted retries; no valid total exists. At 15 requests/minute, pacing alone exceeds seven hours.

A separate October 13 sample over 25,000 blocks returned 44,702 wallet-relevant logs, nine pages, and 41,645,204 response bytes. At approximate 400 ms block cadence, linear projection gives **about 2,333 pages, 11.6 million logs, and 10.8 GB over 30 days**. At the observed free-plan limit of 15 requests/minute, pacing alone exceeds 2.6 hours. This is one-range scenario estimation, not measured whole-window data or PostgreSQL storage. Account IDs are event data, so the source cannot topic-filter by account.

Wallet trades/performance timed out after 90 seconds October 12; a one-row request timed out after 15 seconds October 13. Complete arbitrary-wallet history, net PnL, win rate, liquidation thresholds, equity curves, and drawdown remain unverified. Activity/proven rows cannot substitute. Ledger activation requires staging storage, latency, and budget checks.

## Recorded and synthetic local proof

Fake-RPC tests cover finalized views, account/address roundtrips, hash rereads, reorg refusal, bitmap completeness, and freshness. The 1,000-block recovery replay uses synthetic headers and recorded logs; it proves checkpoint mechanics only.

The archived wallet payload has one position but an eleven-position bitmap, so whole-wallet equity stays null. Q16 short entry remains `5.15296234588623046875`. Entry-block evidence cannot replace its missing snapshot-block hash. Node-to-Flutter loopback tests preserve exact decimals/unavailable values, not fresh wallet state.

Offline cached `/markets`: 400 requests, concurrency 20, p95 3.81 ms; network/cold database latency and production p95 are excluded. Fixtures prove recorded or synthetic behavior, not live financial completeness.
