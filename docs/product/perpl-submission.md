# Best Use of Perpl's API: submission readiness

Eyeler combines mobile-controlled position protection with Grid and inventory-skewed Market Maker execution. Books protect existing positions; Autopilot uses reviewed consent and a dedicated account. Attempted commands and verified completion remain distinct.

## Reviewer access and verdict

System: <https://app.eyeler.xyz>. Use the [signed Android installation guide](../deployment/android-download.md). Public [analytics](https://app.eyeler.xyz/#/analytics) and [reliability observations](https://app.eyeler.xyz/#/status) need no sign-in. Mainnet trading is an allowlisted demo; installation does not grant access.

The [Perpl bounty](https://hackathon.monad.xyz/tracks/best-use-of-perpl-s-api) asks for reliable execution, risk management, profitability potential, real on-chain activity, a system link and a two-minute video. Recorded proof covers a manual opening and an unarmed Book. Autonomous activity, sustained operation and net profit remain unproved. This document does not freshly verify deployment.

## Implemented execution and risk controls

**Books.** The owner reviews a position, liquidation floor, reserve/cap, stance and expiry, then explicitly arms automation. The server chooses HOLD, bounded DEFEND, reduce-only REDUCE or EXIT. Final checks cover freshness, SAFE_MODE, reserve/account capital, connection and global stop. Manual actions require separate authorization.

**Autopilot.** Grid and Market Maker have an implemented LIVE controller, off by default. Both strategy flags, per-user mode, execution permission and lease ownership are required. The owner confirms an expiring configuration/account/environment-bound preview with capital, loss/inventory limits and a one-minute to 24-hour duration. Starting/resuming requires new review.

The account starts flat with no orders/locked balance and cannot share active Books, unresolved openings or another held LIVE allocation. External Perpl-client activity remains possible; unexpected mutations or request IDs halt quoting.

Post-only quotes use exact quantization and worst-case inventory, notional, fees, capital, freshness, volatility and funding checks. Immutable orders, request identity, origin and deadline persist before transmission. Uncertain requests consume budget. Quotes request zero additional negative-PnL collateralization.

**Recovery and cleanup.** UNKNOWN/PARTIAL outcomes reconcile without blind resends. Old referenced attempts are not reclaimed by age. Proven unsent recovery fences delayed preparation and pauses the Book. Strategy replacements wait for verified owned cancellation or terminal recovery. Quote expiry, request deadline, run duration and execution block are distinct.

Pause, stop, kill, loss limits and expiry stop quoting and queue owned-order cleanup; inventory can remain exposed. No maximum realized loss is guaranteed. Capital stays held until flat, resolved orders and a fresh view covering the final request window. See [Autopilot limits](../strategies/mainnet-autopilot.md) and [receipt-proof provenance](../strategies/order-proof.md).

Offline Book, capital and LIVE suites use synthetic transports/receipts. They prove application behavior, not venue fills or availability.

## Recorded evidence

**October 11, 2026:** signed Android build `0fd7d2d` on Vivo V2036 opened one user-approved BTC LONG on mainnet account `5438`: `0.00001 BTC`, `1x`, average fill `82759.5`, position `7364051271681`. Public transaction `0xd6487dd482ca69170a230b8a40d13ee8342a5b3803c628d254702a7b70b0bb1f` had status `0x1` at block `0x6b293a9` when independently checked. A Book used a `5%` floor, `0.50 AUSD` reserve/cap and `24h` DEFEND stance. Automation was off; HOLD / `AUTOMATION_PAUSED` produced no automatic action.

**October 13, 2026:** official Mera SDK creation/recovery was demonstrated on signed Android `ee73baa` with a different, unallowlisted wallet and no trade. The later public APK uses native source `45b214b987df5660bedaaa2499254e4c7ed6d19c`. Neither proves automatic Perpl activity.

The [reliability campaign](../deployment/reliability-run.md) records sampled health, handovers, existing Book/PAPER activity and synthetic faults. Cite actual serving times and coverage; a seven-day plan or idle worker does not prove completed operation or trading.

## Export and check evidence

For a Book, use an authorized read-only database connection, exact UTC window and Book ID. Configure the connection privately; replace these placeholders with the actual run:

```sh
node --import tsx scripts/report.ts \
  --from ACTUAL_UTC_START --to ACTUAL_UTC_END \
  --book BOOK_UUID --out reports/perpl-bounty-run.md
```

For Autopilot, use the [owner-scoped report/publication guide](../strategies/mainnet-evidence.md). After owner review, the server rebuilds the scoped report and stores a sanitized immutable artifact with its source SHA. Public `/evidence/:id` serves HTML/JSON on the API origin; owners can list and revoke publications. The app URL is the system link; the evidence URL exposes the reviewed report.

Only persisted `AUTOMATION` origin qualifies. Strategy mainnet counts also require `environment=mainnet` and `mode=LIVE`; manual, unattributed, PAPER and testnet records do not qualify. Stored command admission is not a fill. Verified fills require ledger identity checks; arbitrary hashes do not qualify. Gross fees include the builder component.

Independently check canonical successful receipts, network, Exchange destination, account/request and operation/fill logs against before/after exposure. Venue-reconciled closes without receipts keep that label. Deadlines are not execution blocks. Preserve historical consent separately. Fill windows use ledger recording time; tick counts show samples rather than uptime. Publications retain `independentlyReverified=false`; publication is not independent verification.

## Profitability and final demonstration

The [evaluation](../strategies/evidence.md) uses 720 BTC candles, disjoint 360/360 windows and 24 sensitivity runs per 1,000 hypothetical AUSD. Grid holdouts change sign; all maker holdouts lose. No winner is selected. Reproduce these simulations with `node --import tsx scripts/strategies-evaluate.ts`.

Account equity includes venue PnL/funding; it is not attributed realized strategy profit. Complete funding, settlement, gas and capital-flow attribution remains unavailable. LIVE net profit and incomplete Book net realized PnL remain unavailable rather than zero. Authentic maker-history request mapping and sustained real recovery/cleanup need separate live proof.

Show the real account/position, reviewed limits and consent, a genuine automatic outcome, Autopsy/report evidence and pause/kill within 120 seconds. Label replays and retain timestamps. Do not force a trigger through unsafe leverage or weaker checks. Review expiry: an expired armed Book can request EXIT.

Before the authorized run, check candidate SHA, release identity, `/ready`, one monitor owner and [credential profile](../deployment/credentials.md). Public launch requires its [KMS profile](../deployment/aws-kms.md) and separate review. A manual trade, test, empty publication or mark-to-market gain cannot replace remaining submission proof.
