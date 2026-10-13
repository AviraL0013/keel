# Eyeler strategies

Eyeler has two distinct automation products. Books monitor an existing Perpl position against owner-defined reserve and risk limits. Autopilot runs Grid or inventory-skewed Market Maker strategies in PAPER mode or through a separately gated LIVE controller.

## Execution boundary

The LIVE controller is implemented. It is disabled by default and requires both strategy flags, per-user account mode, execution authority, a held worker lease, fresh venue state, and the owner's expiring review and confirmation. A feature flag or a saved draft does not authorize a trade.

LIVE admission requires a dedicated initially flat account and a held capital allocation. Application controls prevent sharing that account with an active Book, unresolved opening, or another held LIVE allocation. External account mutations halt quoting. The application cannot prevent its owner from trading through another Perpl client.

Orders and request identity are persisted before transmission. Unknown or partial outcomes are reconciled without blind resubmission. Cancellation targets verified strategy-owned orders; replacements wait for terminal evidence. Pause, stop and kill stop quoting and queue cleanup, but positions can remain exposed.

See [mainnet execution and recovery](mainnet-autopilot.md) for exact consent, ownership, order-expiry, exposure and rollback rules. [Receipt provenance](order-proof.md) describes the pinned SDK fixture and the boundary between command admission and financial settlement.

## Evidence

- [Perpl submission guide](../product/perpl-submission.md): Book protection and automation review.
- [Simulation evidence](evidence.md): recorded candles, disjoint holdout, stress assumptions and losing configurations.
- [Mainnet evidence reports](mainnet-evidence.md): owner-reviewed publication, immutable artifacts and independently checked receipts.
- [Reliability campaign](../deployment/reliability-run.md): worker observation, scheduled restarts and isolated failure tests.

PAPER fills and PnL are simulated. Stored command admission is not fill proof. Verified fill identity and gross fees do not establish complete attributed funding, gas, net strategy profit, or continuous uptime. A successful manual trade is not proof of automatic mainnet execution.
