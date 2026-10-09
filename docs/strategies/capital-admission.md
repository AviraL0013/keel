# Account capital admission

Per-user Books and user-confirmed openings now admit capital under the same PostgreSQL account-owner row lock, scoped by `(environment, account_id)`. The owner row survives credential rotation; old Books and unresolved orders therefore remain claims after a connection expires. The connection must be active, unexpired, trade-enabled, owned by the user, and attached to an unfrozen account with forwarding enabled.

The transaction reloads the server's venue state after obtaining the lock. Guarded venue authorization uses that transaction's client, avoiding a second pool checkout while the pool is saturated. No client-provided balance or observation timestamp is accepted. The venue free balance must have a fresh timestamp and a positive observed chain block. Amounts and claims use exact six-decimal integer money.

## Claims and settlement

Admission subtracts the following claims from the observed free balance before accepting a new commitment:

- Available plus reserved capital for every non-closed Book, including paused and safe-mode Books. A closed Book remains a claim while its DEFEND action is unresolved.
- Collateral and fees for unresolved openings, including UNKNOWN outcomes. A final check excludes only the current opening's own already-persisted claim.
- Every LIVE strategy capital allocation, including paused, stopped and draft rows. LIVE allocation and activation are still unavailable; this query is conservative defense for stored rows, not a live controller.

CONFIRMED and IOC PARTIAL openings retain their cost until the balance's observed block covers the verified operation and fills. A newly received response is insufficient if its chain snapshot precedes execution. A FAILED intent carrying superseded or successful execution evidence is also not proof of no spend. It blocks admission until the balance covers the verified operation and any fills/positions. A superseded payload may cost more than the original preview, so holding only that preview's collateral would be unsafe. Definite pre-send or negative-execution failures without spend evidence release their opening claim.

Settled DEFEND ledger debits retain their claim until the balance covers `venue_progress.confirmedExecutionBlock`. Missing legacy block evidence remains a claim; neither receipt arrival time nor a fabricated block releases it. DEFEND settlement takes the same owner lock before action and reserve locks.

An idle closed Book releases its unused commitment. Credential rotation does not. Testnet and mainnet account numbers are separate. Legacy operator Books without a per-user connection preserve the existing operator path; where they overlap a per-user account number, claims are counted conservatively. This change does not enable per-user mode, openings or live strategies in deployment settings.

## Opening preview lifetime

The preview clock is captured after awaited snapshots arrive. Expiry is checked again after asynchronous admission and immediately before the final pre-send validation returns. A delayed fresh snapshot cannot revive an expired preview. The existing Book-reserve error remains `OPENING_WOULD_UNDERFUND_BOOK_RESERVES`; shared capital overcommitment returns `ACCOUNT_CAPITAL_INSUFFICIENT`. Missing or contradictory balance evidence returns `PERPL_FREE_BALANCE_UNAVAILABLE`.

## Reproducible proof

Focused regressions are in `tests/book-capital-admission.test.ts` and `tests/opening-confirm-gates.test.ts`. They cover the one-micro boundary, duplicate promises, paused/reserved claims, credential rotation, missing/foreign ownership, rollback, a saturated guarded reload, execution-block fences, receipt-backed superseded failures, delayed expiry and environment isolation. `tests/perpl-bounded-reconciliation.test.ts` verifies that a receipt-backed DEFEND retains its execution block.

Independent PostgreSQL-session proof:

```powershell
node --import tsx scripts/verify-product-concurrency.ts
```

This command requires an existing local `postgres:16` Docker image. It creates its own labeled temporary container, binds a random port on `127.0.0.1`, uses a tmpfs fixture database, and verifies its container identity before cleanup. It accepts no database URL or environment credentials. It removes only the container it created. Fixtures use fake venues and fake Telegram replies; no orders, transactions or messages are sent.

The command proves Book-versus-Book admission with a saturated two-client pool, both Book/opening race orders, Telegram command/unlink in both race orders, distinct request IDs across separate Node processes, and migration re-runs against populated fixture data. It is separate from ordinary PGlite tests, whose single database session cannot prove PostgreSQL lock contention.

Remaining live blockers include an explicit strategy confirmation record, allocation/release lifecycle, verified fill and funding accounting, owned-order cleanup, lease enforcement and production KMS setup. These capital tests do not prove those unfinished behaviors or authorize real funds.
