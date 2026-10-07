# Receipt-backed strategy command recovery

The internal strategy submission seam remains unmounted. No live strategy is enabled by this work, and all execution tests use fake RPC, fake venues, or local database fixtures.

## What is proved

`PerplHistory.strategyCommandEvidence` reads signed order history, including OPEN records and CHANGE/CANCEL target records that retain their original POST request ID. It also reads the signed wallet's block and `lfr`. Failed pagination or unavailable receipts throw; an incomplete scan cannot establish absence.

Positive admission requires all of the following:

1. The transaction and successful receipt identify the configured Exchange, the same transaction hash, and consistent block, transaction and log indices.
2. The transaction decodes as a singleton, non-triggered `execFwdPositionOpsV2` command with no nonempty extension.
3. Exactly one `OrderRequest` or `OrderRequestV2` event matches the forwarded command.
4. A uniquely attributable success event follows that context: `OrderPlaced`, `OrderChanged`, or `OrderCancelled`. Placement size and change target/price/size/expiry must match. The CANCEL target comes from the verified request context because `OrderCancelled` itself has no order ID.
5. The command matches the immutable persisted account, request ID, market, type, target, raw size and price, leverage, flags and bounded `lb`. This seam permits GTC lifetime, no triggers, zero forwarded fee and zero extra negative-PnL collateralization. Changed terms or execution after `lb` produce `PERPL_REQUEST_ID_SUPERSEDED`.

A successful transaction can skip an individual command. Its success status alone is therefore insufficient. Unknown Exchange logs, triggers, duplicated contexts, inconsistent stamps and ambiguous batches cannot establish admission. Admin/liquidator cancellation is not proof that Eyeler's CANCEL executed.

The declarations and independent encoding vectors come from the [official Perpl SDK Exchange ABI](https://github.com/PerplFoundation/dex-sdk/blob/main/crates/sdk/abi/dex/Exchange.json). The downloaded full ABI has SHA-256 `766fc81326bdf27f243ca582f65c3e2ff72bc639d88674876697a63ae1c47cb3`. The checked-in `packages/perpl/fixtures/strategy-command-abi.json` contains the relevant unmodified ABI entries. Tests encode against that fixture, separately from the verifier's declarations. The existing API-to-contract order mapping is 1/2 to 0/1 for POST, 5 to 4 for CANCEL, and 7 to 6 for CHANGE.

## Recovery and negative proof

Recovery reloads the exact immutable order, its hash, target, saved request ID, `lb`, and submission time. Missing or altered durable metadata stays `UNKNOWN`; it never falls back to the old snapshot-only fixture helper. A failed mt:24 remains recoverable. Definite pre-send exceptions remain FAILED and are never transmitted.

Database writes compare the original status, request, immutable order JSON, market units, hash, target, `lb`, venue order ID and precise `updated_at`. A slow read cannot overwrite newer recovery proof or an altered intent. The row stores `strategyAdmission` and `strategyOperations` in `venue_progress`. No recovery path resends a command.

The first admitted command pins its transaction, block, request/outcome log indices and venue order ID. A later reuse of the request ID cannot replace that identity or turn an admitted POST into a rejected command. Conflicting receipts keep the original proof and UNKNOWN until the conflict is reviewed. Saved proof is revalidated against the durable terms before reuse for lifecycle observations; it remains separate from fill accounting.

`PERPL_ORDER_WINDOW_EXPIRED` requires complete empty command evidence, a signed wallet block covering `lb`, and the signed 32-bit low-word `lfr` comparison proving the request was not processed. Previously persisted positive admission suppresses this negative inference, including after an `lfr` reset. Ambiguity stays UNKNOWN; the first three minutes are labelled `STRATEGY_OUTCOME_VERIFYING`. Neither a timeout nor a numerically larger request ID proves non-execution.

A renewed credential may read old evidence only for the same verified owner, environment and account. The historical handle has no strategy submission method, and a revoked renewal cannot return evidence.

## What is not proved yet

Command admission and later order settlement are separate. A resting order's `lb` bounds admission only. Later maker fills may occur after `lb` and after three minutes. `st:10` means a command executed; it is not a fill. A verified placement plus a fresh OPEN/PARTIAL snapshot records the observed lifecycle; snapshot filled size is not a financial ledger credit.

This milestone does not settle maker fills, fees, funding, realized PnL or inventory from receipts. Missing lifecycle proof keeps an admitted order UNKNOWN while retaining its admission. It does not release strategy capital. Batch request/outcome ordering still needs independent proof before multi-command receipts can establish admission. These gaps, owned cancellation cleanup and explicit live confirmation still block the production live controller.

## Regression evidence

- `strategies-receipts.test.ts`: independent ABI POST/CHANGE/CANCEL vectors, skipped commands, rejected POST, inconsistent stamps/context, foreign outcomes, ambiguous batches, signed OPEN/target history, superseded markets and unavailable receipts.
- `strategies-command-proof.test.ts`: exact terms, bounded admission, three-minute ambiguity, wraparound `lfr`, partial observations after `lb`, same-block ordering and no fill inference from status 10.
- `strategies-durable-recovery.test.ts`: persisted payload, restart without resend, immutable metadata rejection, stale-write protection, retained admission after `lfr` reset and own-request CANCEL proof.
- `strategies-order-intents.test.ts` and `strategies-recovery.test.ts`: failed updates remain recoverable; legacy metadata stays unverified; recovery continues beyond 100 rows.
- `perpl-user-venues.test.ts`: same-account renewal reads, foreign account refusal and revocation.
- `scripts/verify-product-concurrency.ts`: an independent PostgreSQL session changes the command while a fake evidence read waits. The stale recovery write loses its CAS and preserves the newer row. The fixture has no submission method.
