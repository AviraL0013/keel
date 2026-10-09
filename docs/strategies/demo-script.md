# Perpl Autopilot bounty demo script

Current demo is paper-only. No real order, transaction, funding action or production database write is part of this script.

1. Open Autopilot in a local fixture build. Show grid and inventory-aware market-maker setup with market, account, capital, max notional, inventory, open-order, daily-loss, drawdown, volatility, stale-data, price-band and funding limits.
2. Start PAPER mode. Show public market timestamp, quotes, simulated fills, fee and observed funding interval. Explain that OHLC bars cannot prove queue position or profitability.
3. Trigger stale data, adverse funding, price-band, daily-loss and kill-switch fixtures. Show quotes clear and state HALTED.
4. Open strategy report for a bounded UTC window. Show simulated fills, no fabricated transaction hashes, funding, risk events and observed tick coverage.
5. Show the recorded 30-day sensitivity report. State holdout losses and sign changes plainly; no configuration is selected as profitable.

LIVE remains unavailable until receipt-backed fill accounting, shared-account ownership, atomic capital release, owned cancel-all, lock handover, explicit confirmation, KMS and a separate real-run approval are complete.
