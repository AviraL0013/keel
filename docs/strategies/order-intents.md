# Durable strategy order intents

`StrategyOrders` is an internal submission seam tested with fake venues. It is not instantiated by the production worker, runtime, Telegram commands or HTTP routes. `StrategyStore.start` still refuses LIVE with `STRATEGY_LIVE_WORKER_NOT_READY`.

## Submission and ownership

Only the creator of a new `(strategy_id, idempotency_key)` intent can submit it. Duplicate requests, a reconstructed service, and a crash after preparing a row return that row without sending again. A changed payload under the same key is rejected. JSONB key ordering does not change the SHA-256 hash.

The row stores the normalized raw order, exact display units, target, hash and account/environment binding. The awaited `beforeSend` callback attaches the allocated request ID and bounded expiry with a conditional update before a socket write is permitted. A failed write to the database prevents transmission. The final callback rechecks active connection ownership, forwarding, strategy status, kill controls, immutable payload and the exact persisted reference both before and after asynchronous admission. The saved expiry is compared as canonical decimal text because node-postgres returns `bigint` as a string.

The caller must supply an admission callback. Before this seam can be activated, that callback must prove worker ownership, fresh market terms, account exposure, capital isolation and immutable user confirmation. The `marketTerms` argument is internal server metadata, not an HTTP request field; it must be revalidated before transmission. There is no permissive production implementation of that callback.

CHANGE and CANCEL can target only a real POST from the same strategy, environment, market and account, with a known venue order ID. The service derives that ID from the owned row and persists it for restart recovery. A caller-supplied conflicting ID and a simulated target are rejected.

Socket acknowledgements leave the outcome UNKNOWN. Definite pre-send failures become FAILED; ambiguous writes retain their durable reference. Result and exception updates match the request owned by the current attempt, so they cannot overwrite another submitter or a recovery result. UNKNOWN is never dispatched again.

## Migration 031 compatibility

The forward migration adds nullable metadata columns and scoped indexes to the existing table. Legacy paper and recovery rows remain readable by old code. New keyed intents require complete metadata and an owned target for amendments/cancellation. The migration is safe to rerun and does not rewrite or delete existing rows.

Rollback means keeping LIVE disabled and running the prior application code. Leave the additive columns and indexes in place: the old writer does not populate them, and legacy rows satisfy the compatibility constraint. Do not delete intent rows or drop columns during a rollback; recovery still needs their references. No production migration or database write has been performed for this work.

## Evidence and remaining work

`strategies-order-intents.test.ts` proves duplicate concurrent calls, restart without resubmission, payload conflicts, owner checks, operator/disabled gates, reference failures, admission failures, revocation, reference mutation, CAS races, transport ambiguity, late responses and cancellation restart recovery. `strategies-intents-migration.test.ts` proves reruns, legacy preservation, scoped uniqueness, required hashes and target ownership.

These are local PostgreSQL/WASM fixtures and fake transports. They do not prove independent PostgreSQL sessions serialize correctly, real fills, on-chain receipts, profitability, mainnet readiness, capital isolation or verified cancel-all. Those remain separate delivery milestones. No real order or transaction has been sent.
