# Perpl analytics and risk submission

## Access and product

Open <https://app.eyeler.xyz/#/analytics>. Protocol views, address search, public wallet profiles, and wallet comparison do not require a sign-in, installation, or API key. The dashboard supports phone and desktop layouts. See the [recorded verification](../analytics/verification.md) for the dates and scope of the browser checks.

The overview connects protocol activity to individual markets and wallets. Separate tabs cover volume; open interest, funding and liquidations; revenue and users; flows and TVL; and wallet details. Charts expose timeframes, source timestamps, and unavailable reasons. Missing values are never presented as zero.

## Requirement coverage

| Requirement | Implementation and evidence boundary |
| --- | --- |
| 24h, 7d and 30d volume | Perpl public market data and validated candle sums. Candle windows use completed UTC buckets; the source note identifies the cutoff. |
| Volume since launch | Daily candles for currently listed markets. Delisted-market coverage and fill-side counting are not proven, so this is not a reconciled protocol all-time total. |
| Current open interest and TVL | Perpl OI converted using market precision and mark. With snapshots enabled, TVL is finalized AUSD `balanceOf` the pinned Exchange. |
| OI and TVL charts | Stored observations begin when collection starts. Earlier points remain unavailable; stock values are not summed across hours. |
| Fees, protocol revenue and active users | Covered Exchange-event rollups. Fee and revenue definitions differ. Distinct users require resolved account owners; an unresolved owner leaves the affected result unavailable. |
| Deposits, withdrawals and net flows | Separate collateral-event values and daily buckets. Net flow is deposits minus withdrawals; internal PnL and funding are excluded. |
| Market breakdown and funding | Public Perpl context, per-market candles and funding observations. Opening-activity skew is not relabeled as current open-interest skew. |
| Liquidations | Observed events and covered daily notional rollups. Daily aggregate coverage does not establish a complete raw event feed. |
| Public address search and positions | Checked Exchange account and position views. Entry, size, leverage and current PnL depend on verified enumeration, marks and source freshness. |
| Historical trades and performance | Bounded reconstruction exists, but complete arbitrary-wallet trades, net realized PnL, win rate and equity drawdown remain unverified. Cards expose the unavailable reason. |
| Watch and compare wallets | Public comparison, saved wallet workflow, and session-only live watch. Watch changes are snapshot observations, not historical trade proof. |
| Portfolio and margin | Wallet equity, free and order-locked balances remain separate. Position margin used and liquidation price stay unavailable when their complete inputs or formula are not proven. |
| Optional insights | Position concentration, interactive stress estimates, and live snapshot changes. These are deterministic calculations, not an LLM prediction or trading recommendation. |

## Sources and scope

Perpl public candles and funding are the primary sources for market history. Monad Exchange events support protocol rollups and account mapping. Current wallet state uses checked chain reads. No DefiLlama metric is required by this implementation.

The aggregate event window is 30 completed UTC days, with 35-day rolling retention. Owner mapping and its scan cursor persist so accounts created before the retained window can still be resolved. This is not a deployment-to-head archive. Coverage is reported per metric and per day; a configured start block is not evidence of a completed backfill.

Perpl's authenticated history endpoints describe the calling account, not arbitrary public wallets. Eyeler does not borrow another user's credentials for address search. A full wallet-event ledger is default-off and requires measured storage, latency and Railway budget before activation. See [operations](../analytics/operations.md).

## Review path

1. Open the dashboard signed out. Inspect the source and observation time on the overview cards.
2. Switch 7D and 30D, then inspect the daily volume chart and market breakdown.
3. Compare trading fees with protocol revenue. Inspect the verified-day count for active users.
4. Open Flows & TVL. Compare separate deposits and withdrawals with the net-flow line.
5. Search a public address and inspect its current balances and positions. Try the position insights, stress preview and live watch.
6. Inspect unavailable historical fields and their reasons. Do not present an empty performance card as a zero return.

Stress estimates hold other inputs fixed and exclude fees, funding, execution and position changes. They are not settlement or liquidation predictions. The live watch stops when its page is removed and resets its comparison baseline after a source gap or account-set change. Details are in [wallet tools](../analytics/wallet-tools.md).

The submission also requires the team's up-to-two-minute video. A recording must show the values and coverage actually available at recording time. The dashboard's existence does not establish complete wallet history, profitability, or a completed bounty.
