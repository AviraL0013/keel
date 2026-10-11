# Protocol metric completion audit

Audited 2026-10-11 against the vendored [public REST endpoints](../vendor/perpl-api-docs/rest-endpoints.md), [field types](../vendor/perpl-api-docs/types.md), [fee semantics](../vendor/perpl-api-docs/README.md#fees--fee-tiers), the Analytics [metric definitions](metrics.md), current routes, and unsigned live Perpl responses. This branch changes no HTTP route, indexer, repository, production setting, or contract. The exported completion helper is ready for route integration below.

## What first-party public data proves

| Deliverable | Status | Evidence and exact limit |
| --- | --- | --- |
| 24-hour volume | Partial | Context `state.dva` is an observed **daily volume** amount for each listed market. Perpl does not specify its exact rolling boundary or whether `v`/`dva` count one matched trade once or both fill sides. The existing route shows the context sum; it has no independent previous context snapshot. Completed hourly candles can form a separate previous period, but must not be presented as a reconciled comparison with context. |
| Seven-day and 30-day volume | Partial | Existing route sums each listed market's daily `v` once over completed UTC days, with an equal previous period. Exact integer micros and checked daily continuity prove the returned rows, not a protocol-wide historical total. The values can change upstream after the day closes. |
| All-time volume | Partial | Existing `listedMarketVolume` validates daily resolution, integer micros, first observed 2026-02-12 launch, no interior daily gap, and completed-day cutoff for every **currently listed** market. Current context cannot prove that no market was delisted. The candle contract does not define one-side versus two-side fill counting. A complete first-party candle history for current listings therefore does **not** prove protocol all-time volume. Do not call this a reconciled protocol total. |
| Open interest | Verified live snapshot; unavailable historical series | Public `state.oi` is base size. The helper values each market once at its current mark using exact integer precision and rounds to AUSD micros per market. This is one-side OI. Context has no prior-boundary OI or historical position series. |
| TVL | Verified live snapshot; unavailable historical series | Sum current market `state.tvl` collateral micros exactly. It is market-reported locked collateral, not cumulative deposits. Context has no prior-boundary TVL. |
| Fees | Unavailable for uncovered windows | Public context has fee **rates**, not paid fees. Real gross fees require both maker and taker fill-side fees, including builder portions once and rebates when reported. The existing indexed route can calculate covered windows; no complete live replay is proved. Never multiply a current rate by candle volume. |
| Revenue | Unavailable for uncovered windows | Gross fees are not protocol revenue. Verified protocol-fee settlement events, excluding builder and insurance portions, are required. The public API has no protocol revenue series. |
| Active users | Unavailable for uncovered windows | Distinct settled trader owners need complete fills and historical account ownership. Perpl's signed account endpoints do not provide a public protocol-wide user count. The existing indexed route returns null if owner mapping is unresolved. |
| Capital flows | Unavailable for uncovered windows | Gross external collateral deposits and withdrawals need complete Exchange events. Context TVL changes, funding, and PnL are not deposits or withdrawals. The existing `/protocol/flows` remains null without covered history. |
| Market skew | Unavailable | Public `state.oi` has no long/short split. The existing indexed market route needs complete supported position reconstruction; it leaves both sides null otherwise. |
| Liquidations | Unavailable as a complete window total | The existing API can show observed indexed events, but its summary stays null when history is incomplete. Public REST has no protocol-wide liquidation endpoint. A missing event in partial history is not zero liquidations. |
| Funding | Verified per-market observation/series; unavailable protocol scalar | Public context and funding endpoints supply signed rates per market and interval. The newest event may have an estimated application timestamp that later updates under the same `feb`. No meaningful single protocol-wide rate exists; do not sum or average unlike markets. The existing market funding route is the correct surface. |

`verified` here means the metric's meaning and arithmetic match the published field for that **observed context**, not consensus finality or a synchronized historical boundary. Perpl market states may have different block timestamps. `partial` means a useful, explicitly scoped observation exists but protocol-wide or comparison proof is missing. Missing values are `null` with a reason in `protocol-completion.ts`; unknown is never zero.

## Live comparison

Unsigned GETs at **2026-10-11T06:29:16.465Z** returned 11 listed markets, minimum context market-state block **112397202**. The returned daily rows for those markets ran contiguously from each market's first day through 2026-10-10 UTC after excluding the unfinished 2026-10-11 day. BTC and MON began on 2026-02-12. The request used exact `BigInt` AUSD micros and summed each market/day once.

| Observation | AUSD | Window |
| --- | ---: | --- |
| Context sum `state.dva` | 9,846,075.426999 | Perpl's live daily-volume observation at request time |
| Hourly candle sum | 9,710,857.248394 | 2026-10-10 06:00 to 2026-10-11 06:00 UTC, 24 completed hours |
| Previous hourly candle sum | 9,303,552.273050 | 2026-10-09 06:00 to 2026-10-10 06:00 UTC |
| Completed-day candle sum | 8,485,786.847701 | 2026-10-10 UTC |
| Current seven-day candle sum | 98,370,265.216809 | 2026-10-04 through 2026-10-10 UTC |
| Previous seven-day candle sum | 101,793,710.983211 | 2026-09-27 through 2026-10-03 UTC |
| Current 30-day candle sum | 1,118,407,204.569352 | 2026-09-11 through 2026-10-10 UTC |
| Previous 30-day candle sum | 2,362,341,430.836135 | 2026-08-12 through 2026-09-10 UTC |
| Listed-market completed-day history | 5,508,182,822.098549 | 2026-02-12 through 2026-10-10 UTC, current listings only |

Context exceeds the completed-hour sum by **135,218.178605 AUSD**. The context observation includes a later rolling edge than the last completed 06:00 UTC candle; exact source-window rules remain unpublished. This is a comparison, not a reconciliation. No prior context snapshot exists in public history, so the previous 24-hour hourly sum is not a context-derived `previous` value. Perpl context has no seven-day or 30-day aggregate with which to reconcile those candle windows.

The listed-market all-history observation exceeds the earlier same-cutoff `5,508,178,248.022144` AUSD observation in [verification](verification.md#perpl-public-daily-candle-history-2026-10-11) by **4,574.076405 AUSD**. Earlier immediate repeats also changed a historical BTC candle while the response block stayed fixed. Daily history is a mutable API snapshot. This live check does not establish delisted-market coverage or the upstream fill-side convention.

A separate unsigned context read at **2026-10-11T06:34:51.529Z**, block **112398290**, gave **1,465,883.892277 AUSD** one-side OI and **633,864.290082 AUSD** TVL through the new exact-decimal helper. These later live values are not part of the 06:29 candle comparison.

## Code and route integration

`publicProtocolTotals(markets)` in `perpl-public.ts` checks market identities and scaled fields. It returns independent `bigint | null` totals and reason codes for current OI and TVL. `completePublicProtocol(ctx)` in `protocol-completion.ts` formats those exact integer totals as `WindowValue` fields with source-specific reasons. `readPublicProtocolCompletion(publicData)` catches an unavailable context and reuses the existing 15-second context cache, stale fallback, and eight-second request timeout. No separate network cache or third-party source was added.

To wire the helper into `server/src/interfaces/http/routes/analytics.ts` without changing routes or response shape:

1. Import `completePublicProtocol` from `../../../infrastructure/analytics/protocol-completion.js`.
2. In the `/protocol/summary` cache loader, immediately after `const ctx = await publicData.context()`, add `const completion = completePublicProtocol(ctx)`. Replace the direct `oi` and `tvl` sums with `completion.live.openInterest` and `completion.live.tvl` for the two snapshot `WindowValue` fields; both have `previous: null` and a reason or provenance note. Keep the already implemented 24-hour, seven-day, 30-day, and listed-market all-volume paths unchanged.
3. Where indexed `current` is absent, use `completion.publicHistoryGaps.fees`, `.revenue`, `.activeUsers`, `.netFlows`, and `.liquidations` for summary fields. If the existing candle fallback fails validation, use `completion.publicHistoryGaps.volume` for the null volume field. Keep indexed values when the repository proves coverage. The helper returns null plus a specific reason for public-only gaps. Do not map `marketSkew` or `funding` into a protocol scalar; the existing per-market routes own those fields.
4. Keep `/protocol/timeseries` OI/TVL points null without historical snapshots. The current `TimePoint` contract has no note field; any future historical endpoint requires a separately proved source and contract decision.

In the summary loader, the key replacement is:

```ts
const ctx = await publicData.context()
const completion = completePublicProtocol(ctx)
// Preserve the existing indexed, context, and candle volume selection.
openInterest: completion.live.openInterest,
tvl: completion.live.tvl,
fees: current ? change(current.fees, previous?.fees ?? null) : completion.publicHistoryGaps.fees,
revenue: current ? change(current.revenue, previous?.revenue ?? null) : completion.publicHistoryGaps.revenue,
activeUsers:
  current?.users !== null && current?.users !== undefined
    ? change(current.users, previous?.users ?? null, true)
    : completion.publicHistoryGaps.activeUsers,
liquidations:
  current ? change(current.liquidations, previous?.liquidations ?? null, true) : completion.publicHistoryGaps.liquidations,
netFlows: current ? change(net, prevNet) : completion.publicHistoryGaps.netFlows,
```

These field lines replace their counterparts inside the existing `ProtocolSummary` object; they are not a second summary object. Keep the route's existing `coverage`, `asOf`, `block`, and candle cache handling. For a failed candle fallback, set volume to `completion.publicHistoryGaps.volume` instead of a bare null.

The helper does not set `coverage.completeHistory`. Only the existing indexer checkpoint can establish that status. It does not combine candle totals with indexed fills, alter liquidations, or infer historical OI/TVL from present values.
