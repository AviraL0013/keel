# Verified strategy fill ledger

This is an internal, unmounted ingestion seam. It does not submit orders or enable LIVE startup. Migration 032 is additive: existing paper orders and fills retain their schema and behavior. Rolling back the application leaves the new evidence intact; do not delete evidence tables during rollback.

`StrategyFillLedger.ingest` receives a user, durable POST intent ID and authenticated history fill candidate. The candidate alone is not evidence. The service loads the owned LIVE intent, validates its immutable payload hash and saved command admission, and reads complete finalized blocks and receipts. `verifyStrategyMakerFill` binds the fill to that exact placement generation, including changes, partial fills, removals, account, API/contract market and order IDs, request ID, raw size, price and gross fee. Unsupported transitions refuse credit.

The unique financial identity is `(environment, Exchange address, transaction hash, block-global log index)`, not a strategy ID or a reused resting slot. A composite foreign key binds each event to its original strategy and order. A conflicting ownership/proof is refused. Duplicate reads return the existing credit.

Credit and the exact order-size projection commit in one transaction under order/strategy row locks. A crash between insertion and projection rolls both back. Late evidence remains readable for paused, halted or stopped strategies. Out-of-order partial evidence cannot regress a later terminal result. A cleared partial fill is `CANCELED` with its actually filled size; removal does not make the discarded remainder `FILLED`.

Gross fees use verified `feeCNS` scaled by six decimals. Gross fees already include builder fees; the component is never charged twice. Prices and sizes use immutable server-produced precision captured during admission. The current verifier permits only zero requested builder fees and refuses unsupported negative fee evidence. No binary floating-point arithmetic enters ledger totals.

## Long histories and restart

Each RPC read remains bounded to 128 consecutive complete blocks. The service persists a trusted replay checkpoint after each validated, finalized prefix. It records the last block hash, immutable admission identity, remaining lot size, current limit and whether the original generation ended. The next chunk must start immediately after that block and match its parent hash. A checkpoint is never accepted from an HTTP client.

An ingestion call reads at most four chunks. Longer lifetimes return `STRATEGY_FILL_RECOVERY_PENDING` after persisting progress; a later read resumes it. This is a read-only retry, never an order resend. Earlier fills are proved from an earlier checkpoint or the original receipt; a later checkpoint cannot prove an earlier event. Checkpoint insertion also rereads and locks the immutable admission, refusing rebinding during RPC waits.

## Financial limits

Totals currently expose proved buy/sell size, buy/sell notional and gross/builder fees. They do not claim live strategy inventory, venue average entry, available capital, funding, realized PnL or equity. Perpl positions are account/perpetual state. Attributing their settlement to one strategy requires an exclusive, monitored ownership claim or a complete shared-position attribution model. Paper cash-flow math and an average of fill prices are not a substitute for the venue's Q16 entry residue and signed settlement events.

Pinned SDK evidence at revision `01b9910761755b0a0d9c710c1ede62ab937daa7d`:

- `crates/sdk/src/state/position.rs`: `effective_entry_price`, `apply_mark_price`, `apply_funding_payment`; funding applies to the pre-event position size.
- `crates/sdk/src/state/perpetual.rs`: `funding_sum_converter`, `update_funding`, `take_funding_payment`; consume a scheduled payment at its effective block, not every observation.
- `crates/sdk/src/exchange.rs`: position increase/close handlers consume emitted entry residue and signed settlement amounts. Verified raw amounts avoid inventing contract rounding.

LIVE startup remains refused until financial attribution, capital isolation, verified cancellation and controller recovery are complete.

## Proof

`strategies-fill-ledger.test.ts` covers restart atomicity, duplicate/replayed credits, exact fees, out-of-order evidence, late fills, partial clearing, missing/foreign/forged evidence, finalized coverage, immutable rereads, migration reruns and durable history past the reader bound. `strategies-slot-checkpoint.test.ts` covers continuity, admission binding, ended generations and parent hashes. `verify-product-concurrency.ts` exercises overlapping distinct fills and duplicate ingestion using independent PostgreSQL clients, alongside Book/opening, Telegram, recovery and request-ID concurrency.
