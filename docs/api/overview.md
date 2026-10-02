# API

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

Book ownership and wallet allowlisting are checked server-side. Perpl credentials remain server-side.
