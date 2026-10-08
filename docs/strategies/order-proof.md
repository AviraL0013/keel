# Receipt-backed strategy command recovery

The internal strategy submission seam remains unmounted. No live strategy is enabled by this work, and all execution tests use fake RPC, fake venues, or local database fixtures.

## What is proved

`PerplHistory.strategyCommandEvidence` reads signed order history, including OPEN records and CHANGE/CANCEL target records that retain their original POST request ID. It also reads the signed wallet's block and `lfr`. Failed pagination or unavailable receipts throw; an incomplete scan cannot establish absence.

Positive admission requires all of the following:

1. The transaction and successful receipt identify the configured Exchange, the same transaction hash, and consistent block, transaction and log indices.
2. The transaction decodes as non-triggered `execFwdPositionOpsV2` commands. A supplied extension array must have the same length as the command array. Empty attribution and canonical version-1 builder envelopes are supported; each envelope is bound by command array index and exact `OrderRequestV2` bytes.
3. Each `OrderRequest` or `OrderRequestV2` context matches a unique forwarded account/request identity and every calldata descriptor field. Duplicate identities or repeated contexts reject the receipt proof. Skipped descriptors may have no context; matching never relies on array position.
4. Exchange logs are processed by their verified log index. A request starts a segment; the next request, `OrderBatchCompleted`, or receipt end closes it. A uniquely attributable success event must occur inside that segment: `OrderPlaced`, `OrderChanged`, or `OrderCancelled`. Placement size and change target/price/size/expiry must match. The CANCEL target comes from the verified request context because `OrderCancelled` itself has no order ID.
5. The command matches the immutable persisted account, request ID, market, type, target, raw size and price, leverage, flags, builder attribution and bounded `lb`. This seam permits GTC lifetime, no triggers, zero forwarded fee and zero extra negative-PnL collateralization. Changed terms or execution after `lb` produce `PERPL_REQUEST_ID_SUPERSEDED`.

A successful transaction can skip an individual command. Its success status alone is therefore insufficient. Unknown, trigger, conflicting or unsupported events leave their segment UNVERIFIED without borrowing the next segment's outcome. Logs outside a request segment cannot establish admission. Duplicated contexts and inconsistent stamps reject the receipt proof. Admin/liquidator cancellation is not proof that Eyeler's CANCEL executed.

The declarations and independent encoding vectors come from the [official Perpl SDK Exchange ABI](https://github.com/PerplFoundation/dex-sdk/blob/main/crates/sdk/abi/dex/Exchange.json). The downloaded full ABI has SHA-256 `766fc81326bdf27f243ca582f65c3e2ff72bc639d88674876697a63ae1c47cb3`. The checked-in `packages/perpl/fixtures/strategy-command-abi.json` contains the relevant unmodified ABI entries. Tests encode against that fixture, separately from the verifier's declarations. The existing API-to-contract order mapping is 1/2 to 0/1 for POST, 5 to 4 for CANCEL, and 7 to 6 for CHANGE.

Batch attribution additionally follows the independently published [official SDK state handler at revision `01b9910`](https://github.com/PerplFoundation/dex-sdk/blob/01b9910761755b0a0d9c710c1ede62ab937daa7d/crates/sdk/src/state/exchange.rs). Lines 293–299 process ordered events and reset context between transactions; 1286–1294 replace context on each request; 1084–1087 clear it at batch completion. CANCEL (1089), CHANGE (1150) and POST (1227) consume that context. Request failures do not create a boundary or transfer ownership. The fake ABI vectors cover mixed POST/CHANGE/CANCEL, skipped descriptors, equal request IDs on different accounts, shuffled receipt arrays, request failures and segment boundaries. Signed history still selects only the owned account/request from the verified receipt.

## Recovery and negative proof

### Builder attribution

The [pinned official SDK decoder](https://github.com/PerplFoundation/dex-sdk/blob/01b9910761755b0a0d9c710c1ede62ab937daa7d/crates/sdk/src/types/extension.rs) defines `abi.encode(uint16 version, bytes payload)`, with version 1 and payload `abi.encode(uint256 builderId, uint256 builderFeePer100K)`. Its limits are 256 envelope bytes, builder IDs through 255, and a rate through 1000 Per100K (1%). This verifier supports only the canonical 160-byte encoding; that is a conservative supported subset, not a claim that the contract requires canonical bytes. Malformed, mismatched, missing V2 or unsupported extensions cannot establish admission. A nonempty builder-zero envelope is distinct from an empty extension.

The submission seam derives builder identity from the owning enrolled connection, never from client order fields or a process-wide default. New `market_terms` stores flat `builderId` and `builderFeePer100K` fields, covered by the existing immutable hash and recovery CAS. The requested fee is always zero, even if the enrolled ceiling permits more. As the [vendored builder docs](../vendor/perpl-api-docs/integrations.md#charging-a-builder-fee) specify, omitting wire `bf` means zero fee while retaining the key's builder attribution. No wire fee or enrollment setting is changed here.

Authorization pins the captured connection ID and rechecks builder identity before and after asynchronous admission. Malformed enrollment pairs or rebinding prevent the fake socket write. Recovery uses the original stored terms even when a renewed credential has a different builder binding. Legacy rows retain their original hash and may establish only empty attribution; partial or malformed builder metadata cannot be defaulted to zero. Saved malformed or conflicting attribution remains UNKNOWN while preserving earlier valid proof.

Recovery reloads the exact immutable order, its hash, target, saved request ID, `lb`, and submission time. Missing or altered durable metadata stays `UNKNOWN`; it never falls back to the old snapshot-only fixture helper. A failed mt:24 remains recoverable. Definite pre-send exceptions remain FAILED and are never transmitted.

Database writes compare the original status, request, immutable order JSON, market units, hash, target, `lb`, venue order ID and precise `updated_at`. A slow read cannot overwrite newer recovery proof or an altered intent. The row stores `strategyAdmission` and `strategyOperations` in `venue_progress`. No recovery path resends a command.

The first admitted command pins its transaction, block, request/outcome log indices and venue order ID. A later reuse of the request ID cannot replace that identity or turn an admitted POST into a rejected command. Conflicting receipts keep the original proof and UNKNOWN until the conflict is reviewed. Saved proof is revalidated against the durable terms before reuse for lifecycle observations; it remains separate from fill accounting.

`PERPL_ORDER_WINDOW_EXPIRED` requires complete empty command evidence, a signed wallet block covering `lb`, and the signed 32-bit low-word `lfr` comparison proving the request was not processed. Previously persisted positive admission suppresses this negative inference, including after an `lfr` reset. Ambiguity stays UNKNOWN; the first three minutes are labelled `STRATEGY_OUTCOME_VERIFYING`. Neither a timeout nor a numerically larger request ID proves non-execution.

A renewed credential may read old evidence only for the same verified owner, environment and account. The historical handle has no strategy submission method, and a revoked renewal cannot return evidence.

## What is not proved yet

The current command parser proves contract command identity, not the production API-to-contract order bridge. The vendored `Order` has an API `oid` and a separate smart-contract `scid`; the official ABI documents reusable 16-bit contract order slots. The current wire model omits `scid`, so fixtures with equal IDs do not prove real order ownership. CHANGE/CANCEL targets and later maker fills require an independently verified placement lifetime before they can be associated with an API order. The bridge is a release blocker and must be tested with distinct IDs and reused slots.

The vendored `BlockTxLogTimestamp.l` is a transaction-local log index. An RPC receipt's `logIndex` is block-global. Their relationship must be normalized using the full ordered receipt, including logs from other contracts; comparing the two numbers directly is not production proof. The [official SDK maker-fill handler](https://github.com/PerplFoundation/dex-sdk/blob/01b9910761755b0a0d9c710c1ede62ab937daa7d/crates/sdk/src/state/exchange.rs#L2149) resolves the historical resting order, rather than assigning maker fills to the current taker's request context. This identity and stamp bridge precedes any real fill ledger or live activation.

Command admission and later order settlement are separate. A resting order's `lb` bounds admission only. Later maker fills may occur after `lb` and after three minutes. `st:10` means a command executed; it is not a fill. A verified placement plus a fresh OPEN/PARTIAL snapshot records the observed lifecycle; snapshot filled size is not a financial ledger credit.

This milestone does not settle maker fills, fees, funding, realized PnL or inventory from receipts. Missing lifecycle proof keeps an admitted order UNKNOWN while retaining its admission. It does not release strategy capital. Unsupported or noncanonical extension formats remain unverified; a zero fee does not remove attribution bytes. Financial settlement, owned cancellation cleanup and explicit live confirmation still block the production live controller.

## Regression evidence

- `strategies-receipts.test.ts`: independent ABI POST/CHANGE/CANCEL vectors, manually encoded SDK builder envelopes, mixed-builder batch ownership, malformed/range/version/missing-V2 rejection, skipped commands, rejected POST, inconsistent stamps/context, foreign outcomes, batch context isolation, duplicate identities, signed OPEN/target history, superseded markets and unavailable receipts.
- `strategies-command-proof.test.ts`: exact terms, bounded admission, three-minute ambiguity, wraparound `lfr`, partial observations after `lb`, same-block ordering and no fill inference from status 10.
- `strategies-durable-recovery.test.ts`: persisted payload, restart without resend, immutable metadata rejection, stale-write protection, retained admission after `lfr` reset and own-request CANCEL proof.
- `strategies-order-intents.test.ts` and `strategies-recovery.test.ts`: failed updates remain recoverable; builder terms are server-derived and immutable; malformed enrollment and connection rebinding cannot write; legacy metadata stays unverified; recovery continues beyond 100 rows.
- `perpl-user-venues.test.ts`: same-account renewal reads, foreign account refusal and revocation.
- `scripts/verify-product-concurrency.ts`: an independent PostgreSQL session changes the command while a fake evidence read waits. The stale recovery write loses its CAS and preserves the newer row. The fixture has no submission method.
