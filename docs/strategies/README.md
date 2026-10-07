# Eyeler Autopilot: strategy engine status

This branch implements deterministic grid and inventory-aware market-making strategies, a candle backtester, and a persistent paper worker using public Perpl observations. **It places no live orders.** `LIVE` configuration is refused by default; starting a live strategy is refused even if an older row exists. `EYELER_STRATEGIES_LIVE_ENABLED` is an additional guard on the venue adapter, not a way to activate this worker. The mobile dashboard labels paper fills as simulated.

## Current phases

| Phase                 | Status              | Evidence and remaining work                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Order management   | PARTIAL             | Post-only, change, and cancel frames use the existing Perpl session, bounded `lb`, serial request-ID allocator, and account submission lock. Snapshot/history reconciliation preserves `UNKNOWN` on ambiguous absence; recovery reads venue evidence without resubmitting. There is no live strategy order controller or real cancel-all orchestration on shutdown, lease loss, and kill. |
| 2. Strategy framework | PARTIAL             | Validated config, deterministic `onTick`/`onFill`/`onFunding`/`onRiskEvent`, persisted paper state, and offline backtest. Live worker is deliberately unavailable.                                                                                                                                                                                                                        |
| 3. Strategies         | DONE for simulation | Bounded post-only grid and inventory-skewed maker quotes with volatility spread and refresh limits. Paper and backtest account for configured maker fees and funding. Exchange fee/funding receipts have not been reconciled in live mode.                                                                                                                                                |
| 4. Risk               | PARTIAL             | Strategy limits, daily loss, drawdown, volatility, stale source timestamps, mark/oracle bands, funding guard, user kill, and `EYELER_EXECUTION_DISABLED` halt paper quotes. Live capital admission against Book reserves, automatic Book protection, and real-order kill cancellation remain.                                                                                             |
| 5. Evaluation         | PARTIAL             | Public Perpl fixture, conservative deterministic simulator, metrics, and ignored JSON reports. Candle data cannot prove maker fills, queue position, or actual profitability.                                                                                                                                                                                                             |
| 6. Control            | PARTIAL             | Owner-bound HTTP API, mobile setup/dashboard, and linked private Telegram commands for paper strategies. Live confirmation and activation are unavailable.                                                                                                                                                                                                                                |
| 7. Proof              | PARTIAL             | Run-report CLI groups fills, available transaction hashes, PnL observations, risk events, and observed tick-minute coverage. No on-chain strategy activity exists yet.                                                                                                                                                                                                                    |

## Backtest snapshot

The checked-in fixture `packages/strategies/fixtures/perpl-mainnet-btc-2026-10-05.json` contains 25 hourly BTC candles and 33 funding observations fetched from public Perpl endpoints. These are one narrow historical window, not an out-of-sample evaluation. Starting capital is 1,000 quote units for each configuration.

| Strategy     |         PnL | Max drawdown | Sharpe-like | Fills / quoted orders |   Turnover |       Fees |    Funding |
| ------------ | ----------: | -----------: | ----------: | --------------------: | ---------: | ---------: | ---------: |
| Grid         | +0.50843749 |  0.18769776% |  0.25853276 |                5 / 39 | 0.43214286 | 0.01166786 | 0.02586608 |
| Market maker | -0.15166615 |  0.20094926% | -0.06920212 |               19 / 50 | 1.63100862 | 0.03864099 | 0.06162861 |

The simulator fills a resting quote only on a later candle that strictly crosses its price, caps participation to 1% of quoted depth, and skips bars whose high and low could trigger both sides in an unknown sequence. Fees apply to opening volume and funding to held inventory. OHLC bars have no queue, order-book, latency, or mark/oracle path. The small positive grid result is **not** evidence that it would make money live. The maker result is negative in this fixture.

Reproduce with:

```powershell
npx tsx packages/strategies/src/backtest-cli.ts packages/strategies/fixtures/btc-grid-config.json packages/strategies/fixtures/perpl-mainnet-btc-2026-10-05.json
npx tsx packages/strategies/src/backtest-cli.ts packages/strategies/fixtures/btc-maker-config.json packages/strategies/fixtures/perpl-mainnet-btc-2026-10-05.json
```

Reports are written under `reports/strategies/` and ignored by Git.

## Run report

With an authorized local database connection, run:

```powershell
npx tsx server/src/infrastructure/strategies/report-cli.ts --from 2026-10-05T00:00:00Z --to 2026-10-06T00:00:00Z
```

The JSON output distinguishes simulated fills and lists transaction hashes only when recorded for non-simulated fills. Tick-minute coverage is an observation count, not a process-uptime guarantee. This branch has no real fills or hashes to report. No production database was queried or changed for this evaluation.

## Before a separate live mainnet run

The internal [durable intent seam](order-intents.md) now has fake-venue proof. It remains unmounted; the production live controller and the steps below are still required.

1. Implement and test a live controller that persists an intent before sending, reconciles each request against mt:24/history/snapshot, and never resubmits `UNKNOWN`.
2. Add real cancel-all of strategy-owned open orders on halt, shutdown, lease loss, and kill; verify each cancellation by venue evidence. Keep Book orders untouched.
3. Atomically reserve strategy capital outside Book reserves and other strategies. Add optional Book DEFEND/REDUCE/EXIT protection for strategy inventory, with ownership and sizing checks.
4. Add a separate user confirmation record per strategy, then require it, `EYELER_STRATEGIES_LIVE_ENABLED=true`, and `EYELER_EXECUTION_DISABLED` unset for every live send. Validate market/account permissions and exposure against fresh venue state immediately before sending.
5. Exercise disconnects, partial fills, rejections, restarts, lease loss, and cancellations against a testnet account. Review maker fee and funding reconciliation with receipts, plus exchange limits and live monitoring.
6. Obtain the user's separate go-ahead for mainnet funds/orders. Then collect actual transaction hashes, fills, PnL, risk events, uptime evidence, a two-minute demo, and a link for the bounty submission.

The live feature flag alone does not satisfy these steps and must not be treated as permission to place orders.
