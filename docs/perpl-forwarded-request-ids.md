# Perpl forwarded request IDs

## Verified failure and deployed contract rule

On 2026-09-26, read-only RPC inspection of testnet Exchange
`0x1964c32f0be608e7d29302aff5e61268e72080cc` resolved its EIP-1967 implementation to
`0xbcbd3701ed0bde8acbb727f0d92a8b85a169adbb`. The runtime code hash was
`0x29ef64f8efca11ce9cd1f0ab39ef08cd7bd02955b52075db44be95a8b4dcf620` (128,336 bytes).
The same implementation and code were present immediately before the failed transaction
`0x22951e0d54b39db37f84cd51139064b75674bf84c725bc21c42b2f2c2823328b`, at block 65807879.

The SDK Exchange artifact has a different full hash, so byte identity with the SDK must
not be claimed. Disassembly of the deployed code itself shows the non-trigger forwarding
check at PCs 55581–55617: load the stored 32-bit counter, mask the candidate to 32 bits,
subtract, mask, `SIGNEXTEND 3`, then signed greater-than zero. Failure emits
`OrderDescIdTooLow(lastOrderDescId)` at PC 55633.

For ordinary KEEL orders (no trigger registration), the enforced serial rule is:

```text
int32(uint32(rq - lfr)) > 0
```

KEEL also requires the full uint64 `rq` to exceed the fresh API `lfr`, every locally
reserved ID, every persisted action reference for that account, and the signed history's
known forwarded sr=32 high-water mark. Direct UI/on-chain order-history IDs do not seed
the forwarding allocator. No timestamp fallback is used.

The failed request was 1790412137977 (`0x1a0dce125f9`). With `lfr=0`, its signed low-word
delta is **-589224455**. Incrementing it by one would still fail. The smallest candidate
above it with a valid serial delta is **1791001362433** (`0x1a100000001`, delta 1).
This is calculated from state; it is not hardcoded in the allocator.

## Read-only historical proof

Run `node scripts/verify-perpl-request-id.mjs`. It uses public RPC reads and
`debug_traceCall`; it has no signer, broadcast call, or database writes.

Decoding the original transaction with Perpl's Exchange ABI yields
`execFwdPositionOpsV2`, account 642, market 16, `orderDescId=1790412137977`, and
`amountCNS=11321`. API type 6 maps to contract order type 5 (increase collateral).

At the parent block, simulated execution with the original ID emits
`OrderDescIdTooLow(0)`. Changing only that ID to 1791001362433 emits
`IncreasePositionCollateral`, with amount 11321, position deposit 551130 and free
balance 99446089. These simulated changes were not persisted. Both calls return a zero
order signature, so the signature alone cannot establish success for collateral changes.

This verifies the contract path. It does not prove a new live gateway submission or
current economic completion. KEEL still requires authenticated venue admission and
post-action account/position reconciliation. Unknown transport outcomes stay unknown.

## Allocation and safety

The allocator locks the account row, chooses the smallest unused uint64 in the valid
signed-32 window, and commits it before the WebSocket send. If the next integer falls
outside that window, it skips to the next low word equal to `uint32(lfr + 1)`.
Overflow, missing baseline, stale WS authority and unexplained serial-valid sr=32
rejections fail closed. A known serial-invalid rejection may be superseded by a new,
validated ID above it; this does not reset or alter the old action. There is no automatic
resubmission after sr=32 or an ambiguous transport outcome.

An older WS snapshot and a newer REST snapshot are compared using the same serial rule,
so the normal uint32 wrap from 4294967295 to 0 is not mistaken for a stale REST baseline.
The selected ID is checked again against WS account authority immediately before sending.
Existing Book/position unresolved-action, risk, reserve, cap and permission checks remain.

Sources:
- https://github.com/PerplFoundation/dex-sdk/blob/main/crates/sdk/abi/dex/Exchange.json
- https://github.com/PerplFoundation/api-docs/blob/main/types.md
- https://github.com/PerplFoundation/api-docs/blob/main/websocket.md
