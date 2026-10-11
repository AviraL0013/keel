# Eyeler Analytics redesign

Branch: `feat/analytics-redesign`. Base: `origin/main` at `2dc6523` (2026-10-11).

## Base and ownership — DONE

`origin/main` contains completion merge `1ccdb82`, completion head `3bacf9c`, integrated rollups `30d6223`, on-demand wallet routes `c7e779f`, and wallet unavailable-state fix `1f57c30`. A rebase onto `origin/feat/analytics-completion` was not needed. The separate helper branches have later commits which are not ancestors of this main head; they were not pulled into the UI branch.

The original clean redesign worktree was detached after Windows refused a directory move. Implementation lives at `C:/Users/lenovo/keel-app/.worktrees/analytics-redesign`. The original `C:/Users/lenovo/keel-analytics-redesign` still contains the unchanged base. The integrator's worktrees were not changed.

Changes are confined to `apps/mobile/lib/features/analytics/`, `apps/mobile/test/analytics/`, and this report. No server, API contract, routing configuration, authentication, execution, activation, CI, or shared tracker changes. No merge or deployment.

## Visual direction and public route — PARTIAL (deployed browser inspection)

The dashboard uses a near-black canvas, bordered cards, Eyeler's existing violet accent, Manrope, and large tabular numbers. The existing Eyeler mark is retained. The layout takes section navigation, large metrics, and focused chart cards from [Nado's layout](https://stats.nado.xyz/), with the broad sections, market table, coverage strip, and wallet depth requested from [HyperScreener's layout](https://hyperscreener.asxn.xyz/). No reference brand assets or exact palette were copied.

The [public route](https://app.eyeler.xyz/#/analytics) returned HTTP 200. Managed browser inventory was empty, so interactive inspection of the deployed page was unavailable. The local implementation is reviewed through Flutter-rendered screenshots. Public deep-link tests continue to prove that the route does not read private session storage.

## Overview and navigation — DONE

- Six sections; global 7D / 30D / 90D / All chart range; desktop address field; Ctrl+K and Cmd+K focus even when no text field holds focus; phone search opens a full-screen route.
- Up to four KPI cards and two chart cards per desktop row. At 360 dp, all cards stack in one column. The header also supports the existing 320 dp regression gate.
- 24h volume, all-time volume, current OI, and current TVL use their own correct windows. The chart selector does not relabel these fixed-window KPIs. Changes appear only when the API supplies both a previous value and a change.
- Flow/trader/fee strip and all-time strip retain source coverage. Candle volume says “Since first candle · listed markets”; indexed totals retain their API coverage label.
- Snapshots and historical cards load independently. In-flight requests coalesce; snapshots cache for 30 seconds and histories for five minutes. Requests time out independently after 18 seconds. Polling pauses in the background and while another route covers the dashboard.

Tests: `Overview DashboardTestState.* at 360dp/1280dp`, `global timeframe updates independent chart requests and preserves 24h KPI`, `Ctrl K and Cmd K focus global search; address opens profile`, `phone search opens full-screen lookup with 48dp target`, `parallel endpoint loads cache and coalesce without waiting for slow history`, and the existing public deep-link and app-shell tests.

## Volume — PARTIAL (API history by market)

The protocol chart has daily bars, cumulative visible-period volume on the right axis, D/W/M aggregation, bar/line/area controls, exact crosshair values, keyboard inspection, legend toggles, a range brush, and CSV export. Weekly/monthly edge buckets are explicitly described as sums of the visible daily buckets. Missing points never become zero; a gap stops the cumulative series. Market snapshots open market detail.

The deployed v1 API supplies only aggregate historical volume. It does not supply per-market volume history. The UI states this and renders the protocol series. The additive `marketSeries` shape below is already accepted by the client, with strict reconciliation to the authoritative total before stacking.

Tests: `Volume DashboardTestState.*`, `tooltip exact values, legend, chart type, brush and CSV at 360dp/1280dp`, `range brush exports only dates and series still visible`, `weekly and monthly totals preserve explicit and implicit missing days`, `optional market series must reconcile with authoritative volume`.

## OI, Funding & Liquidations — PARTIAL (history availability)

Current OI and funding appear by market. Market detail independently loads price and funding history with CSV and exact tooltips. Price ranges support up to two years; funding explicitly caps its requested view at 30 days / 1,024 observations because the current endpoint has that limit.

OI history is requested from the existing endpoint. When missing, the current value is shown with a coverage note, without a fake chart or guessed recording-start date. The liquidation feed retains unknown totals and clickable addresses. Daily liquidation bars require either a complete, unpaginated response or the optional daily totals below; the first page is never presented as a full daily total.

Tests: `OI, Funding & Liquidations DashboardTestState.*`, `market drill-down opens independent price and funding history`, `optional revenue, recording dates, daily liquidations and margin fields activate without replacing v1`.

## Revenue & Users — PARTIAL (daily revenue and source coverage)

The UI separates gross trading fees from protocol revenue, shows verified 30-day totals when supplied, and requests the existing daily fees and active-user series. No distinct-user total is inferred by summing daily users. Daily revenue activates when the optional revenue history envelope below is supplied; otherwise it gives the source's reason. The deployed recording contains no verified fee/user history.

Tests: `Revenue & Users DashboardTestState.*`, the exact decimal and optional-field tests.

## Flows & TVL — PARTIAL (source history)

Deposits and withdrawals have separate semantic badges and chart series. Withdrawals plot below zero; the net series remains a line. Daily bars sum only returned source buckets with exact decimal arithmetic. Missing dates are never filled. The selector filters the available response; 90D and All use the existing `all` flow route and retain its actual coverage label. TVL shows the current snapshot while historical observations are absent.

Tests: `Flows & TVL DashboardTestState.*`, `daily flows sum only observed hours and preserve exact signs`.

## Wallets — PARTIAL (upstream performance/trades failure)

Profiles show equity, verified aggregate unrealized PnL, available margin, locked order collateral, account balance, and nullable 30-day realized PnL / win rate. Margin used remains unavailable until the server supplies a verified value; locked collateral is not mislabeled as margin used. Performance is not labeled 30-day unless the envelope confirms that window. Positions, trades, and performance have separate tabs. Watch uses the existing local store; comparison supports up to four wallets and loads each snapshot independently. Exact full addresses open profiles without requiring prefix-search indexing first.

At capture time, the public wallet snapshot returned HTTP 200, while both `/wallets/:address/performance` and `/wallets/:address/trades?limit=50` returned HTTP 500 with `HYPERSYNC_NUMBER_INVALID`. These failures do not block the profile. This is a concrete server issue for the integrator, not a reason to infer performance from current positions.

Tests: `Wallet DashboardTestState.*`, `Wallets comparison DashboardTestState.*`, `wallet survives performance failure; Watch and Compare retain real address`, `prefix search opens redesigned wallet and saves watchlist`.

## Chart interaction and exact values — DONE

Money stays in decimal strings; aggregation uses `BigInt` coefficients and decimal scales. Doubles are used only to draw pixel coordinates and compact axis ticks. Tooltips and CSV retain original values. CSV exports only visible series and dates, retains null as an empty field, and escapes spreadsheet formula-like labels. Web uses a browser Blob download; native platforms copy CSV with Flutter's clipboard API. No dependency was added.

Tests: `exact aggregation and CSV retain decimal strings beyond double precision`, `errors are evicted and foreign history ranges rejected`, the tooltip/legend/type/brush/CSV tests, and existing exact-value chart tests.

## Recorded evidence and screenshots — DONE

`apps/mobile/test/analytics/fixtures/mainnet-2026-10-11.json` contains 22 public, read-only `/analytics/v1` responses, captured at `2026-10-11T12:04:34.449932+00:00` from the mainnet Railway API. The individual envelopes retain their distinct observation times. Golden screenshots use these recorded bodies, including the real missing history and wallet HTTP failures. State tests alter availability explicitly; they are not represented as mainnet measurements.

Screenshot paths (Windows; equivalent Linux baselines live in the sibling `linux` directory):

| Screen                     | 360 dp                                                                              | 1280 dp                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Overview                   | [Phone](../../apps/mobile/test/analytics/goldens/redesign/windows/overview-360.png) | [Desktop](../../apps/mobile/test/analytics/goldens/redesign/windows/overview-1280.png) |
| Volume                     | [Phone](../../apps/mobile/test/analytics/goldens/redesign/windows/volume-360.png)   | [Desktop](../../apps/mobile/test/analytics/goldens/redesign/windows/volume-1280.png)   |
| OI, Funding & Liquidations | [Phone](../../apps/mobile/test/analytics/goldens/redesign/windows/oi-360.png)       | [Desktop](../../apps/mobile/test/analytics/goldens/redesign/windows/oi-1280.png)       |
| Revenue & Users            | [Phone](../../apps/mobile/test/analytics/goldens/redesign/windows/revenue-360.png)  | [Desktop](../../apps/mobile/test/analytics/goldens/redesign/windows/revenue-1280.png)  |
| Flows & TVL                | [Phone](../../apps/mobile/test/analytics/goldens/redesign/windows/flows-360.png)    | [Desktop](../../apps/mobile/test/analytics/goldens/redesign/windows/flows-1280.png)    |
| Wallet                     | [Phone](../../apps/mobile/test/analytics/goldens/redesign/windows/wallet-360.png)   | [Desktop](../../apps/mobile/test/analytics/goldens/redesign/windows/wallet-1280.png)   |
| Wallets search             | [Phone](../../apps/mobile/test/analytics/goldens/redesign/windows/wallets-360.png)  | [Desktop](../../apps/mobile/test/analytics/goldens/redesign/windows/wallets-1280.png)  |

Golden tests: `recorded mainnet {overview,volume,oi,revenue,flows,wallets,wallet} {360,1280} golden` in `dashboard_golden_test.dart`.

All twenty-eight Windows and Linux images were inspected before committing. Review corrected initial font inheritance, waited for the first logo decode, kept the active phone tab visible, and aligned desktop KPI row heights. No overflow or clipped values remain in these viewports. Browser download behavior is compile-checked by the web build; the exact CSV and native clipboard path are exercised in widget tests. A managed interactive browser was unavailable for a live download check.

## Exact additive API requests for the integrator — PARTIAL

These are requests, not modifications to the API contract. Every addition is optional. Existing responses remain valid, and the UI already accepts the shapes below. Values in these shape examples are illustrative and must be replaced with independently verified data.

### 1. Historical volume by market

Path: `GET /analytics/v1/protocol/timeseries?metric=volume&interval=1d&from=<UTC>&to=<UTC>`.

Add `data.marketSeries?: Array<{marketId: number; symbol: string; points: Array<{time: string; value: string|null}>}>`. Every series must have the same ordered timestamps as `data.points`. Known market values must sum exactly to the protocol value. Post-launch gaps are null, not zero. A missing or inconsistent optional series falls back to the existing total.

```json
{
  "data": {
    "metric": "volume",
    "interval": "1d",
    "from": "2026-10-01T00:00:00.000Z",
    "to": "2026-10-02T00:00:00.000Z",
    "points": [{ "time": "2026-10-01T00:00:00.000Z", "value": "3.000000" }],
    "marketSeries": [
      { "marketId": 1, "symbol": "BTC", "points": [{ "time": "2026-10-01T00:00:00.000Z", "value": "1.000000" }] },
      { "marketId": 2, "symbol": "ETH", "points": [{ "time": "2026-10-01T00:00:00.000Z", "value": "2.000000" }] }
    ]
  }
}
```

### 2. Recording-start and missing-history reasons

Paths: existing `/protocol/timeseries?metric=oi|tvl&interval=1d&from=<UTC>&to=<UTC>`.

Add `data.historyStartedAt?: string|null` (UTC ISO timestamp of the first actual snapshot recording) and `data.unavailableReason?: string|null`. Do not reuse the raw-event indexer's coverage start as a snapshot-history start.

```json
{
  "data": {
    "metric": "oi",
    "interval": "1d",
    "from": "2026-10-01T00:00:00.000Z",
    "to": "2026-10-02T00:00:00.000Z",
    "points": [],
    "historyStartedAt": "2026-10-11T12:00:00.000Z",
    "unavailableReason": "No completed daily snapshots yet."
  }
}
```

### 3. Revenue history without an unsupported endpoint probe

Path: `GET /analytics/v1/protocol/summary?window=30d`.

Add `data.revenue.history?: {asOf: string; block: number|null; source: AnalyticsSource; stale: boolean; coverage?: Coverage; data: {interval: "1d"; from: string; to: string; points: Array<{time: string; value: string|null}>}}`. Use net protocol fee credits only; no insurance or builder fees. The UI crops this history to the global selector and displays its actual bounds rather than extending 30 days into a 90-day claim.

```json
{
  "data": {
    "revenue": {
      "value": "1.000000",
      "previous": null,
      "changePct": null,
      "history": {
        "asOf": "2026-10-11T00:00:00.000Z",
        "block": null,
        "source": "monad_exchange",
        "stale": false,
        "data": {
          "interval": "1d",
          "from": "2026-09-11T00:00:00.000Z",
          "to": "2026-10-11T00:00:00.000Z",
          "points": [{ "time": "2026-10-05T00:00:00.000Z", "value": "1.000000" }]
        }
      }
    }
  }
}
```

### 4. Daily liquidation totals independent of feed pagination

Path: `GET /analytics/v1/liquidations?from=<UTC>&to=<UTC>&limit=100&cursor=<optional>`.

Add `data.dailyNotional?: {interval: "1d"; from: string; to: string; points: Array<{time: string; value: string|null}>}`. Bounds must equal the requested bounds. Totals must cover the whole filtered range independently of `items` pagination. Keep uncovered days null.

```json
{
  "data": {
    "items": [],
    "nextCursor": null,
    "summary": { "count": null, "notional": null },
    "dailyNotional": {
      "interval": "1d",
      "from": "2026-09-11T00:00:00.000Z",
      "to": "2026-10-11T00:00:00.000Z",
      "points": [{ "time": "2026-10-05T00:00:00.000Z", "value": null }]
    }
  }
}
```

### 5. Verified wallet margin used

Path: `GET /analytics/v1/wallets/:address`.

Add `data.margin.used?: string|null` and `data.margin.usedUnavailableReason?: string|null`. Define and verify used margin across all Exchange accounts and positions at the same finalized snapshot. Do not substitute `locked` without establishing the same meaning.

```json
{
  "data": {
    "margin": {
      "balance": "10.000000",
      "locked": "1.000000",
      "free": "9.000000",
      "equity": null,
      "used": null,
      "usedUnavailableReason": "Complete position collateral is not verified."
    }
  }
}
```

### 6. Existing wallet endpoints returning HTTP 500

Paths: `/analytics/v1/wallets/:address/performance` and `/analytics/v1/wallets/:address/trades?limit=50`.

The recording contains `{"error":"HYPERSYNC_NUMBER_INVALID",...}` with HTTP 500. Resolve the upstream decoding issue in the integrator's server scope. Retain explicit unavailable values/reasons and `Last 30 days` coverage; do not return fabricated zero performance while ownership enumeration is incomplete. No new endpoint is needed.

## Gates and delivery — DONE

Flutter 3.47.5 is used on Windows and Linux. Final code gates:

| Gate                                             | Result                                 |
| ------------------------------------------------ | -------------------------------------- |
| `flutter analyze --no-pub`                       | PASS — no issues                       |
| `flutter test --no-pub` on Windows               | PASS — 388 tests                       |
| `flutter test --no-pub` on Linux                 | PASS — 388 tests                       |
| `flutter build web --no-pub --no-wasm-dry-run`   | PASS — release JavaScript web build    |
| `flutter build apk --debug --no-pub`             | PASS — debug APK built                 |
| Twenty-eight recorded-mainnet golden screenshots | PASS — all visually reviewed           |
| Ownership and `git diff --check`                 | PASS — only authorized analytics paths |

The Android build reports existing Kotlin Gradle Plugin migration warnings and a deprecated API in `passkeys_doctor`. These are outside the authorized scope and do not fail the build.

The final web gate disables only Flutter's optional Wasm compatibility probe. An interrupted earlier build reported existing `flutter_secure_storage_web` incompatibilities during that probe; the normal JavaScript release build completed successfully. This branch does not claim Wasm support. The production deployment job is restricted to pushes on `main`; this feature branch does not deploy.

Implementation commits: `e13b7ae` (data/cache), `7e6399b` (charts/export/style), `eb7d181` (wallet/market detail), `0f87f6f` (dashboard/navigation), `bb752e6` (fixtures/tests/goldens), and `70adbf9` (screenshots for every section). Delivery is the `feat/analytics-redesign` branch in `AviraL0013/keel`. The integrator owns the merge. No merge or deployment is performed.
