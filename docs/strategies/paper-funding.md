# Forward-paper funding

The paper worker uses unsigned public funding history, not wallet credentials. It requests only three configured funding intervals from the environment's Perpl API. Context must report the expected chain. The series must identify the requested market. Public 401/403 responses stop the sample without another source.

An interval is identified by `feb`, matching `at.b`; a corrected timestamp is not another payment. Only `div=1` is supported because that payment scaling is independently established in the recorded API example. The simulated charge is signed inventory multiplied by observed `ppl`, divided by the market price scale. Positive payments debit long inventory and credit short inventory. Mark multiplied by rate is not substituted for a missing payment.

A new, flat simulation establishes a cursor at the latest effective interval without charging historical exposure. Existing inventory or financial activity without that cursor refuses attribution. A missing interval, conflicting financial fields, changed market/precision/interval, stale chain head or event received after its effective time was already covered halts the simulation. It clears simulated quotes. Missing intervals can represent rates never set by the venue; this implementation deliberately refuses to infer their financial effect.

Effective block and time must both be covered by the observed public head. A scheduled event is not charged early. The worker uses one time captured after all feed reads for funding, freshness checks, simulated fills and refresh. Funding is charged before fills in that observation. No trade between observations is asserted; this is a discrete simulation, not verified on-chain inventory.

The cursor, funding projection, simulated payment and simulated orders commit together through the existing strategy version compare-and-swap. A restart or a timestamp correction of the same interval does not charge again. The cursor has no authority over LIVE accounting or capital release.

Tests: `strategies-paper-funding.test.ts`, `strategies-paper-feed.test.ts`, `perpl-funding-history.test.ts` and the funding/restart/freshness cases in `strategies-worker.test.ts`. All use fake fetch, injected adapters or the local PostgreSQL/WASM fixture. A 24-hour forward run has not yet been recorded. Simulated fill, fee and PnL results cannot prove profitability.
