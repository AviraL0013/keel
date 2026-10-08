# Analytics bounty demo script

This script proves recorded read-only analytics behavior. It does not use credentials, private wallet routes, orders or transactions.

1. Start the API with analytics fixture mode on a local loopback server. Confirm `GET /analytics/v1/protocol/summary?window=24h` shows `asOf`, `block`, `source` and `stale`.
2. Open protocol overview. Show headline windows, UTC series, net flows, markets, skew, funding and liquidations. Keep incomplete-history labels visible.
3. Open BTC market detail. Change 24h to 7d. Show recorded close series, freshness badge and null tail where coverage is incomplete.
4. Search recorded wallet `0x5D8FfA5F7c6A42470B4eC61a8CdAbB799fd3765A`. Show balance, locked margin, one verified short position and exact Q16 entry. Show `Wallet positions 1/11` and null equity; this is correct incomplete evidence, not a fabricated total.
5. Open watchlist and compare. Show that wallet values remain decimal strings and private `/books` remains 401 without a session.

For a later public deployment, repeat with a read-only authenticated route after explicit approval. Do not claim complete historical coverage, profitability or live wallet data until the progress file marks those proofs DONE.
