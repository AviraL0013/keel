# API

Public analytics adds `GET /analytics/v1/markets/:id/prices?interval=1h|1d&from=<UTC>&to=<UTC>` for completed candle closes. Values are exact decimal strings; missing or unfinished buckets are null. See [analytics v1](analytics-v1.md) for limits, freshness, provenance and the other read-only routes.

Routes below match `server/src/interfaces/http/register.ts` as of 2026-09-28.

Public status:

- `GET /`
- `GET /health`
- `GET /ready`
- `GET /metrics`

Wallet session:

- `POST /auth/challenge`
- `POST /auth/verify`
- `GET /auth/session` (valid session required)
- `POST /auth/logout`

Books and controls (authenticated):

- `GET /books`
- `POST /books` (supports `marketId`, `venueAccountId`, `venuePositionId`)
- `GET /books/:id`
- `PATCH /books/:id`
- `POST /books/:id/controls`
- `PATCH /books/:id/controls`
- `POST /books/:id/arm`
- `POST /books/:id/pause`
- `POST /books/:id/recover`
- `POST /books/:id/kill`
- `POST /books/:id/close`
- `POST /books/:id/actions` (`DEFEND` or `REDUCE`)
- `POST /controls/kill-switch`
- `GET /books/:id/position`
- `GET /books/:id/telemetry`
- `GET /books/:id/risk`
- `GET /books/:id/state`
- `GET /books/:id/autopsy`
- `GET /books/:id/decisions`
- `GET /books/:id/actions`
- `GET /books/:id/reserve`

Connections, capital, and notifications (authenticated):

- `GET /connections`
- `POST /connections/revoke`
- `POST /connections/perpl/enrollment` (development/testnet key enrollment; returns typed data, never a credential)
- `POST /connections/perpl/enrollment/:id/complete` (wallet signature)
- `POST /connections/perpl/:id/disconnect` (shreds local credentials; Perpl web UI handles venue revocation)
- `POST /connections/perpl/validate`
- `GET /connections/perpl/positions`
- `GET /capital`
- `GET /capital/agora-activity?cursor=<opaque>` (cursor optional; returns only the session wallet's records and an optional `nextCursor`)

`/capital` reports wallet collateral token, Perpl free and locked balances, user-owned Book allocations, and a reserve-coverage warning as separate sources. Each source can independently be unavailable. Testnet wallet collateral is USD; mainnet is AUSD. Optional `AGORA_METRICS_ENABLED=true` adds a read-only global AUSD supply card. Agora activity is not a balance or a Perpl collateral credit; transaction hashes are shown as evidence, and matches stay advisory.

- `POST /devices`
- `GET /notifications`
- `POST /notifications/:id/read`

Test venue (authenticated; only when the deterministic test runtime is enabled):

- `POST /dev/test-venue/scenario`

`POST /books/:id/close` enters the server execution worker. It never reports a position closed before venue reconciliation. `POST /connections/perpl` is not registered. Enrollment is a backend foundation only; Books and the trading runtime still use the existing server-wide Perpl key.

Opening trades (authenticated; previews and confirmation require per-user mode and `EYELER_OPENING_ENABLED=true`):

- `GET /openings/markets` lists Perpl market IDs, symbols, and open/closed status.
- `GET /openings/markets/:id/snapshot` returns a fresh market and wallet snapshot, including observed times, precision, order window, fee tier, and free balance. Missing or stale values fail closed.
- `POST /openings/previews` accepts `marketId`, `side` (`LONG` or `SHORT`), exact decimal `size`, explicit decimal `leverage`, and optional `slippageBps` (default 50, maximum 200). It returns a user-bound, 15-second preview ID and quote. It does not submit a trade.
- `POST /openings/confirm` accepts `previewId` and a UUID `idempotencyKey`. The server revalidates current venue state, funds, and Book reserves; persists the request ID and bounded `lb` before sending one IOC marketable limit order. Repeating the key returns the same order without another send.
- `GET /openings/:id` returns the session user's persisted opening state and evidence. It remains readable when opening execution is disabled. Statuses include `VERIFYING`, `CONFIRMED`, `PARTIAL`, `FAILED`, and `UNKNOWN`. `UNKNOWN` and IOC `PARTIAL` are never resubmitted automatically.

The feature flag defaults off; the server rejects enabling it in operator mode. A worker-lock owner reconciles persisted requests from signed history and receipt-backed forwarded operations. The app offers “Protect this position” only after the resulting open position appears in the current authenticated Perpl snapshot; it then enters the existing Create Book policy flow. No Book is created automatically.

Book ownership and wallet allowlisting are checked server-side. Perpl credentials remain server-side.
