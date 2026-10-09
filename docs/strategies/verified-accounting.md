# Verified strategy accounting seam

`packages/strategies/src/verified-accounting.ts` provides an unmounted exact-decimal projection for independently verified strategy fills. Each event requires immutable identity, block/transaction/log ordering, receipt proof, signed-history proof and original-order proof. Duplicate identity with the same evidence is a no-op. Changed evidence, missing proof or unseen out-of-order events fail closed; callers must replay sorted evidence rather than calculate a different result from arrival order.

Fills use signed inventory and weighted average entry. Opposite-side fills realize `(exit - entry) × closed size` for long inventory and `(entry - exit) × closed size` for short inventory. Remaining opposite inventory starts a new average at the crossing fill price. Fees and signed funding costs remain separate exact-decimal totals. JSON restart preserves applied identities and the last sequence.

This module does not verify receipts, read venue history, submit or cancel orders, release capital, attribute shared-account positions, or enable LIVE. `StrategyFillLedger` remains the authority that must establish those proofs before projection. Funding and settlement formulas, account/perpetual ownership and full-history recovery remain release prerequisites.

Proof: `tests/strategies-verified-accounting.test.ts` covers duplicate/restart safety, weighted entry, partial close, realized PnL, fee/funding mix, exact decimal strings, out-of-order rejection, missing evidence and changed-identity rejection.
