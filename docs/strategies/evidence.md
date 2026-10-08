# Strategy reliability evidence

This document separates offline simulation, fake-venue proof and real activity. No real strategy order, funding, transaction, deployment or production database change was performed. LIVE remains unmounted even when feature flags are set.

## Recorded evaluation

On 2026-10-08 at 08:41:44 UTC, unsigned Perpl public requests recorded BTC hourly candles from 2026-09-08 08:00 UTC through 2026-10-08 08:00 UTC (exclusive). The fixture contains 720 consecutive candles and 1,000 funding observations. Funding was fetched in windows below 500 configured intervals. The API documents that intervals without a set rate may be absent; this response count does not establish receipt-level funding completeness.

Fixture: `packages/strategies/fixtures/perpl-mainnet-btc-2026-09-08-10-08.json`. SHA-256: `944f730b8884f5a0b29b4b1876c3d27650bbaa415e29173f999eb09b63b1e1c1`. Public source URLs and capture time are included. The fee schedule is the current base schedule observed during capture, not a proved historical user tier.

The first 360 candles form the training window; the last 360 form a disjoint holdout. Every run starts flat with 1,000 hypothetical AUSD. No configuration is selected using these results. Predeclared sensitivity choices are grid levels 4/8/12 and maker spreads 10/20/40 bps.

Two hypothetical execution scenarios are evaluated:

- Moderate: 1% volume participation, 25 AUSD queue ahead, 5 bps penetration and 5 bps adverse-selection cost.
- Severe: 0.1% participation, 100 AUSD queue ahead, 20 bps penetration and 20 bps adverse-selection cost.

The queue and adverse-selection assumptions are stress parameters, not observed queue positions. Sizes round down to the venue precision. Quotes are formed only after a candle closes, and can fill only during a later candle. Ambiguous two-sided bars are skipped. All simulated quotes expire at the next close. Adverse-selection cost is reported separately from venue fees.

Funding uses the recorded rounded payment per lot, once per `feb`, with timestamp updates replacing the prior observation. Conflicting financial terms fail. Only `div=1` is supported; other divider semantics are unverified and refused. Funding applies to pre-bar inventory before hypothetical close-time fills. Intrabar funding exposure remains unknown. This simulator uses floating-point paper state and is not the exact LIVE financial ledger.

Holdout PnL (hypothetical AUSD):

| Parameter       |     Moderate |       Severe |
| --------------- | -----------: | -----------: |
| Grid, 4 levels  |   6.27692500 |  -3.24050000 |
| Grid, 8 levels  |   9.21845714 | -20.10744579 |
| Grid, 12 levels | -12.59611818 |  -9.25307818 |
| Maker, 10 bps   | -37.26285868 | -44.67490400 |
| Maker, 20 bps   | -20.44118583 | -29.84595126 |
| Maker, 40 bps   |  -1.55838396 |  -8.63217225 |

All maker configurations lose in this holdout. Grid results change sign across assumptions. These results do not prove profitability or justify enabling real trading. Candles cannot reconstruct actual queue, order lifetime, mark/oracle paths, liquidation, latency or precise intrabar funding. A longer horizon and forward observation are still needed.

Reproduce offline:

```powershell
node --import tsx scripts/strategies-evaluate.ts
```

The full output, including drawdown, fees, funding, risk events and equity curves, is written to ignored `reports/strategies/sensitivity.json`. Public recapture is separate and explicit:

```powershell
node --import tsx scripts/strategies-record-window.ts 30
```

The recorder has a fixed public origin, unsigned GET requests only, bounded windows and timeouts. HTTP 401/403 ends capture without alternate access.

## Proving tests

- `strategies-backtest.test.ts`: recorded fixture, exact observed payment in simulation, same-interval update, missing/conflicting funding, unsupported scaling, candle gaps/invalid OHLC, touch refusal, queue/participation/penalty stress and candle-close timing.
- `strategies-recording.test.ts`: fixed unsigned origin, completed hourly coverage, wrong-chain refusal, bounded funding requests and immediate 401/403 stop.
- `strategies-evaluation.test.ts`: 720-candle recording, disjoint 360/360 split, no selected winner, all 24 sensitivity runs, short-window and LIVE refusal.
- Existing `strategies-core.test.ts`, `strategies-orders.test.ts`, `strategies-command-proof.test.ts`, `strategies-fill-ledger.test.ts` and `strategies-capital-lifecycle.test.ts` provide component fault proof. They do not prove an integrated LIVE controller.

## Remaining proof

No 24-hour forward paper run has completed. No integrated LIVE restart, kill/cancel, lease-loss or handover exercise has completed. Exact account/perpetual funding and settlement attribution, exclusive baseline, safe capital release and the LIVE controller remain unfinished. There are no real strategy fills, receipts, realized PnL or uptime claims. These gaps remain release blockers.
