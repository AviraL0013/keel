# Last 30 days protocol rollups

## HyperSync speed measurement

Measured 2026-10-11 UTC, within the first 30 minutes of this task, against Monad mainnet (chain 143) at `https://monad.hypersync.xyz/query`. The authenticated token came from `EYELER_HYPERSYNC_TOKEN` in `.env`; it was never logged. The source was Perpl Exchange `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`. The script selected 15 event signatures used by the requested metrics, with log block number, block hash, transaction identity, data, and topics. It used `JoinNothing`, 100,000-block partitions, 12 concurrent readers, and HyperSync `next_block` pagination. No response or raw event was persisted. This measures network fetch and JSON parsing, not decoding or database writes. It is not a count of every Exchange event signature.

| Measure                |                                          Result |
| ---------------------- | ----------------------------------------------: |
| UTC block-time span    | 2026-09-11 08:50:26 through 2026-10-11 08:50:19 |
| Inclusive block range  |                         103,853,156–112,425,280 |
| Selected Exchange logs |                                      10,793,721 |
| HyperSync pages        |                                           6,359 |
| Total fetch time       |                                       232.346 s |
| Fetch throughput       |                                 46,455.4 logs/s |

Reproduce from repository root with `node --env-file=.env --experimental-strip-types scripts/analytics-hypersync-benchmark.mjs`. This sends the token only as a bearer header. [Envio's HyperSync examples](https://docs.envio.dev/blog/index-robinhood-chain-data) document exclusive `to_block`, `next_block` pagination, and token use.

An additional all-signature, count-only run (`--all-count`) was attempted in the same first 30 minutes. HyperSync returned repeated retryable responses and the run ended with `HYPERSYNC_RETRY_EXHAUSTED`, so it has no valid total or throughput. No all-signature throughput claim is made. The metric-signature measurement above completed before this throttling and is the sizing input for the rollup worker.

## Rollup scope

The worker and `readLast30Days` helper are independent of the existing raw-event analytics indexer. Only hourly and daily aggregate rows, distinct account membership per UTC bucket, and completed block-range coverage are retained. No transaction hash, log index, payload, or event args are stored. The worker prunes bucket data and completed coverage older than 35 days. It reads newest missing block ranges first, then follows finalized HyperSync height from the API process. It has its own advisory lock `(143, 20261011)`; the trading lock `(187471, 1)` is never acquired or queried.

`market_id = -1` denotes the protocol total. Fees sum maker and taker fill fees once each; revenue sums position protocol fees and does not add them to gross fees. Flows sum external collateral deposits and withdrawals; net is deposits minus withdrawals. Liquidation count is event count and notional is liquidated lot times liquidation price. Active users are distinct owners with maker fills or nonliquidation position actions, covering taker activity whose fill event has no account ID. The worker reads `AccountCreated` separately back to Exchange deployment and writes only the owner dimension into active-account buckets. The helper returns `activeUsers: null` while ownership is unresolved, alongside a distinct `activeAccounts` diagnostic. Market long/short skew is the share of newly opened or inverted positions by side in the last 30 days. It is activity skew, not open-interest skew; position exposure that predates the window cannot be reconstructed from 30 days of events alone.

## Integrator wiring

`server/src/interfaces/http/routes/analytics.ts` remains owned by the integrator and is not edited here. Import `readLast30Days` from `server/src/infrastructure/analytics/rollup-repository.ts`. For the last 30 complete UTC days:

```ts
const toMs = Math.floor(Date.now() / 86_400_000) * 86_400_000
const rollup = await readLast30Days(pool, {
  grain: 'day',
  from: new Date(toMs - 30 * 86_400_000),
  to: new Date(toMs),
})
if (rollup === null) throw fail('ANALYTICS_ROLLUP_INCOMPLETE', 503)
const protocol = rollup.markets.find((market) => market.marketId === -1)!
const money = (value: bigint) => ({ value: signedMoney(value), previous: null, changePct: null })
const count = (value: bigint | null) => ({
  value: value?.toString() ?? null,
  previous: null,
  changePct: null,
})
const eventMetrics = {
  fees: money(protocol.feesMicros),
  revenue: money(protocol.revenueMicros),
  activeUsers: count(rollup.activeUsers),
  liquidations: count(protocol.liquidationCount),
  netFlows: money(protocol.netFlowsMicros),
}
// Use rollup.to as asOf and Number(rollup.throughBlock) as the block.
// For /protocol/flows, format depositsMicros, withdrawalsMicros, and netFlowsMicros.
```

For a rolling hourly view, use `grain: 'hour'` and `toMs = Math.floor(Date.now() / 3_600_000) * 3_600_000`, then subtract exactly 30 days. The helper validates the 30-day UTC bucket bounds, reads a single database snapshot, and returns `null` until block coverage is contiguous across the period. Use the `marketId: -1` entry for protocol fees, revenue, deposits, withdrawals, net flows, and liquidations. Other market entries expose `longOpens`, `shortOpens`, and `openingLongSharePct`. This is **opening activity skew**; do not assign it to `MarketSummary.longSharePct`, which describes open-interest skew. Label event responses **Last 30 days**; set `previous` and `changePct` to `null`. Do not calculate a previous period from this store. Show `activeUsers: null` if ownership remains unresolved; `activeAccounts` is diagnostic only.

Enable the worker in an existing mainnet API process with `EYELER_ANALYTICS_ROLLUPS_ENABLED=true` and `EYELER_HYPERSYNC_TOKEN`; apply migration `021_analytics_rollups.sql` first. No Railway service or trading lock change is needed. The worker uses a dedicated two-connection pool, a 12-second idle cadence, and a 12-block confirmation margin. Each iteration reads at most one bounded tail chunk and one descending backfill chunk; an occasional owner-mapping slice runs afterward. Network delays can lengthen an iteration. Leave the flag off in testnet and nonproduction environments.
