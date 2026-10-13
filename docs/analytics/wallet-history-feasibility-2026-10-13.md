# Public-wallet history feasibility, 2026-10-13

Read-only mainnet HyperSync probe. The local token was sent only in the HTTPS authorization header; no token or event payload was saved.

| Bounded range | Pages | Selected logs | Response bytes |
| --- | ---: | ---: | ---: |
| 112,900,000–112,925,000 (25,000 blocks) | 9 | 44,702 | 41,645,204 |
| 112,900,000–112,905,000 (5,000 blocks) | 3 | 14,858 | 13,844,103 |

The selector included maker/taker fills, position opens/increases/decreases/closes/inversions, and liquidations, including V2 forms. In the 5,000-block sample, counts were 4,532 maker fills, 2,897 taker fills, 2,696 increases, 2,999 decreases, 694 opens, 690 closes, 349 inversions, and one liquidation. No account filter is possible because account IDs are event data, not indexed topics.

At Monad's approximate 400 ms block cadence, 30 days is about 6.48 million blocks. Linear projection from the 25,000-block sample is **about 2,333 HyperSync pages, 11.6 million selected logs, and 10.8 GB of response data**. At the observed free-plan limit of 15 requests/minute, request pacing alone would take at least 2.6 hours, before retries, parsing, owner proofs, and database writes. This is a scenario estimate from one recent range, not a measured 30-day total. It rules out treating a fresh full-window scan on every wallet page as a viable request path. It also argues against retaining all raw logs in the existing cost-limited Railway database without a separate size and cost plan.

Current production `/wallets/0x5d8ffa5f7c6a42470b4ec61a8cdabb799fd3765a/trades?limit=1` returned no bytes before a 15-second client timeout on 2026-10-13. The same day's active-user series returned 30/30 verified daily values; no additional active-user replay is needed. The affordable near-term path is public live market data, current wallet state, rollup-backed wallet activity, and explicit unavailable reasons for unproved trade history and net performance.
