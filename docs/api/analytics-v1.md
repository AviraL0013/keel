# Analytics API v1

Base path: `/analytics/v1`. Public, read-only JSON. Contract types: [`packages/analytics/src/contract.ts`](../../packages/analytics/src/contract.ts). Each endpoint has a synthetic response fixture in [`packages/analytics/fixtures`](../../packages/analytics/fixtures). Fixtures demonstrate shape, not observed mainnet totals.

## Common rules

Every response is `{ "asOf": ISO8601, "block": number|null, "source": string, "stale": boolean, "data": object }`. `asOf` is observation time; `block` is latest finalized Monad block included. `source` is `perpl_api`, `monad_exchange`, `derived`, or `external`. `stale` is true when data exceeds endpoint freshness threshold or ingestion is behind. Never interpret null as zero. Money and prices use decimal strings; money has six fractional digits. Counts are decimal strings in summary metrics. Percentages use decimal strings, where `20.00` means 20%. Funding rate is signed fraction per market funding interval.

Time values use UTC ISO 8601. `window` accepts `24h`, `7d`, `30d`, `all`. For `all`, prior window and change percentage are null. For other windows, `previous` is equal-length immediately preceding period. `changePct` is null when previous is zero or unavailable. `from` is inclusive, `to` exclusive. Maximum timeseries span: 90 days for `1h`, 2 years for `1d`; maximum 2,160 points. Missing points have `value: null` rather than invented zero. `interval` accepts `1h` or `1d`.

Public routes use 60 requests/minute per IP. Responses carry `Cache-Control`; target TTL is 15 seconds for live snapshots, 60 seconds for historical series, 5 minutes for completed daily buckets. CORS allows `https://app.eyeler.xyz` and a configured future analytics origin. Errors use `{ "error": "CODE", "message": "..." }`; invalid query/path returns 400, unknown market or unindexed wallet returns 404, unavailable source returns 503 with `Retry-After`. Target p95: under 250 ms from local database/cache, excluding internet latency. No partial successful response may masquerade as complete.

## Protocol

| Endpoint | Data |
| --- | --- |
| `GET /protocol/summary?window=24h` | `ProtocolSummary`: volume, fees, revenue, active users, liquidations, open interest, TVL, net flows. Each has `value`, `previous`, `changePct`. |
| `GET /protocol/timeseries?metric=volume&interval=1h&from=...&to=...` | `ProtocolTimeseries`: metric, interval, bounds, ordered `{time,value}` points. Metrics: `volume`, `oi`, `tvl`, `fees`, `active_users`, `net_flows`. |
| `GET /protocol/flows?window=24h` | `ProtocolFlows`: gross deposits, gross withdrawals, net and ordered buckets. |

## Markets and liquidations

| Endpoint | Data |
| --- | --- |
| `GET /markets` | `{items: MarketSummary[]}`; each has 24h volume, OI, long and short OI, long share, current funding and mark. |
| `GET /markets/:id` | `MarketDetail`: summary plus TVL, precision and funding interval. |
| `GET /markets/:id/funding?from=...&to=...` | `MarketFunding`: historical `{time,block,rate}`. Max 1,024 intervals. |
| `GET /liquidations?marketId=&from=&to=&limit=50&cursor=` | `LiquidationPage`: items, opaque `nextCursor`, and summary for full filtered range. Limit 1–100. Default last 24h. |

## Wallets

Wallet addresses must be EIP-55 checksummed (or all lowercase) Ethereum addresses. Search accepts full address or prefix of at least six hex digits after `0x`; returns only indexed wallets. Wallet endpoints never require a signed Perpl key.

| Endpoint | Data |
| --- | --- |
| `GET /search?q=` | `{items: [{address, accountId}]}`; up to 20 matches. |
| `GET /wallets/:address` | `WalletProfile`: margin balance, locked, free and equity, plus open positions with size, entry, leverage, unrealized PnL and liquidation price. Unknown derived values are null. |
| `GET /wallets/:address/trades?limit=50&cursor=` | `TradePage`: newest first; opaque keyset cursor. Limit 1–100. `realizedPnl` null when no close/inversion evidence. |
| `GET /wallets/:address/performance` | `WalletPerformance`: realized PnL, win rate, profit factor, drawdown, streaks, hold time, best/worst markets and equity curve. Metrics use closed position episodes. |
| `GET /wallets/compare?addresses=0x...,0x...` | `WalletCompare`: 1–4 distinct addresses in request order, same performance shape. |

## Data caveats

Perpl public REST provides context, market snapshots, candles and funding. Its account/fill/position history requires a signed account API key, so public wallet analytics must use Exchange logs and verified account mapping. Indexer must establish ABI and deployment block before claiming all-time completeness. Liquidation price and unrealized PnL are null until exact venue formulas and current mark can be verified. See [`metrics.md`](../analytics/metrics.md) for definitions and provenance.

## CHANGELOG

- 2026-10-07: Initial v1 contract and synthetic endpoint fixtures.
