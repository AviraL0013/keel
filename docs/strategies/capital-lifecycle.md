# Strategy capital lifecycle

Migration 033 adds durable allocations and per-order reservations. The internal `StrategyCapital` service is not mounted by the runtime and cannot send orders. Its balance and order-cost readers are required server-owned dependencies; they run after the same account owner row lock used by Books and openings, and reuse that transaction's client.

A new allocation requires a paused LIVE strategy and a fresh stamped account balance covering all Book claims, unresolved openings and LIVE strategy allocations. Legacy strategies without allocation rows retain their full conservative capital claim. A held allocation has `available + reserved = amount`. Each POST intent can reserve its exact cost once; changed terms, changed costs, unavailable balances and stale balances refuse. Reusing a held reservation still checks fresh coverage.

Idle release requires STOPPED or HALTED, an existing allocation, and no transmitted, ambiguous or filled exposure. Never-sent queued intents are atomically failed before the allocation is released, so their before-send compare-and-swap cannot win later. Missing legacy allocations refuse release rather than pretending a fallback claim disappeared. Leak reports include idle legacy claims and do not repair them.

Filled or transmitted capital remains held. Releasing it after a verified cancellation or settlement needs the full financial/position lifecycle; a status label alone does not prove that account collateral is reusable. All LIVE starts still return `STRATEGY_LIVE_WORKER_NOT_READY`.

The fill ledger and capital service both lock the strategy before its order rows. Independent PostgreSQL sessions prove that a fill writer waiting on the strategy does not lock the order first. This prevents the capital/ledger lock inversion reproduced before the fix.

Proof: `tests/strategies-capital-lifecycle.test.ts` covers exact six-decimal boundaries, restart idempotency, fresh-state refusal, idle release, legacy leak reports, unresolved exposure and migration reruns. `scripts/verify-product-concurrency.ts` uses only its own isolated PostgreSQL fixture and proves the lock order alongside existing Book/opening races. Integrated three-way live submission and settlement release remain unverified.
