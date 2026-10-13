# Mainnet Autopilot execution

Grid and Market Maker have an implemented Perpl execution path. This document describes its consent, recovery and risk boundaries. Implementation does not establish that LIVE is enabled, that a particular revision is serving, or that real automatic trading has been demonstrated. Deployment and recording evidence must be checked separately.

## Admission and account scope

LIVE is disabled by default. The existing `EYELER_STRATEGIES_ENABLED` and `EYELER_STRATEGIES_LIVE_ENABLED` flags must both be exactly `true`, account mode must be `per-user`, execution must be enabled, and the runtime must own its PostgreSQL lease. These are operator prerequisites, not instructions to change production configuration.

A LIVE draft does not authorize trading. Its owner reviews the account, market, capital, loss and inventory limits, and a run duration between one minute and 24 hours. The server issues an expiring preview bound to the strategy configuration, account, connection, environment and version. Confirmation consumes that preview atomically and rechecks fresh venue state under the account capital lock. A client `liveConfirmed` field cannot substitute for this review. Starting or resuming LIVE requires a new review.

Use a dedicated account that starts without positions, resting orders or locked balance. The account cannot share an active Book, an unresolved manual opening, or another held LIVE allocation. Book and opening capital admission also reject the held strategy account. This fence applies to application admissions; it cannot prevent the account owner from trading directly through another Perpl client. Unexpected request IDs, account mutations, deposits or withdrawals halt quoting. An owner must keep that account exclusive throughout the run.

## Execution and recovery

The existing signed Perpl transport allocates monotonic request IDs. Immutable orders, origin, market precision and request execution windows are persisted before transmission. Automation explicitly requests zero additional negative-PnL collateralization. Proposed prices and sizes are quantized with exact decimal arithmetic. Values that cannot fit Perpl's safe integer wire fields are refused.

Grid and inventory-skewed Market Maker submit post-only opening orders. Perpl opposing opening orders can reduce or invert the account's existing position. Quotes are checked against worst-case inventory if either side fills, gross notional, capital, fees, market price bands, data freshness, volatility and funding. Admission repeats immediately before a frame can leave the server. Existing pending requests consume budget even if their outcome is uncertain.

Refresh cancels only orders bound to the strategy's verified placement generation. Replacements wait for receipt-backed cancellation or verified terminal recovery. Disconnects and crashes never cause blind order resends. Read-only recovery binds fill candidates to complete finalized Exchange lifecycle receipts and resumes durable checkpoints. A signed API response, an acknowledgment, or an order admission is not fill proof.

Each automated quote also has a native last-valid block, derived from the market's current order TTL. The Exchange can expire that resting quote while the application is offline. This block limit is separate from the reviewed run duration. Retiring an expired order requires a finalized account observation beyond both its quote lifetime and request execution window; expiration does not claim that earlier fills were zero.

## Risk limits and retained positions

Loss, drawdown, stale data, run expiry, a kill switch, or an execution disable stops new quoting and queues owned-order cancellation. These controls do not guarantee a maximum realized loss. They do not automatically flatten an open position. Pause, stop and kill can leave inventory exposed; the UI says so explicitly. A held capital allocation remains protected until the stopped account is flat, orders are resolved, and its last request execution window is covered by a fresh account view. PAUSED retains its allocation.

Risk observations use a complete authenticated account snapshot and same-block Exchange account and position views. Equity uses the venue's own position PnL, including its funding calculation and entry rounding. It is account equity, not attributed realized strategy profit. A separate verified fill ledger provides exact fill and gross-fee evidence. Full funding, gas and settlement attribution remains unavailable, so the report keeps LIVE net profit unavailable. Existing simulations do not establish a profitable strategy.

The account history guard requires settlement events to identify an owned request. Missing or unsupported settlement provenance halts the strategy. Authentic mainnet maker history must confirm this request mapping before sustained operation is claimed; fake transport tests cannot establish venue history behavior.

## Evidence and submission link

The intended trading-system link is `https://app.eyeler.xyz`. A branch implementation does not demonstrate that this candidate is deployed there.

After an explicitly approved real run, the owner can review and publish a sanitized report from Autopilot. The server builds the report from that owner's stored records and its environment, captures its source commit SHA, and saves an immutable artifact. Public `GET /evidence/:id` supports a dark HTML page or JSON. The UI copies the API-host evidence URL. Private strategy endpoints remain authenticated. Owners can list and permanently revoke their publications.

The page distinguishes automatic mainnet command admissions, stored verified fills, simulated fills and unresolved outcomes. Publishing an empty report does not establish real mainnet automation. Independently inspect the linked receipts and their account/request identities. Manual trades do not prove automatic execution. No profitability claim or completed-bounty claim follows from this code.

The owner handles the submission video. A real account, approved capital and loss limits, a run duration, a successful automatic mainnet outcome, and independent receipt verification are still required before submission claims can be made.

## Schema and rollback

Migrations 039 and 040 add consent, cleanup state, execution origin and reviewed public artifacts. They do not arm existing records. Run migrations before deploying the candidate. Application rollback must first halt LIVE runs and verify owned-order cleanup. Disable LIVE execution before disabling the strategy scheduler. Preserve evidence and allocations during rollback; dropping evidence tables is not a safe rollback.

## Sources

- [Official Perpl order and delivery semantics](https://github.com/PerplFoundation/api-docs/blob/main/websocket.md)
- [Official Perpl account and position types](https://github.com/PerplFoundation/api-docs/blob/main/types.md)
- [Pinned Exchange view ABI](https://github.com/PerplFoundation/dex-sdk/blob/01b9910761755b0a0d9c710c1ede62ab937daa7d/crates/sdk/abi/dex/Exchange.json)
- [Mainnet evidence publication limits](mainnet-evidence.md)
