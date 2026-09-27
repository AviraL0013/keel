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
- `POST /connections/perpl/validate`
- `GET /connections/perpl/positions`
- `GET /capital`
- `GET /capital/agora-activity`
- `POST /devices`
- `GET /notifications`
- `POST /notifications/:id/read`

Test venue (authenticated; only when the deterministic test runtime is enabled):

- `POST /dev/test-venue/scenario`

`POST /books/:id/close` enters the server execution worker. It never reports a position closed before venue reconciliation. Perpl key enrollment is not exposed by this API; `POST /connections/perpl` is not registered.

Book ownership and wallet allowlisting are checked server-side. Perpl credentials remain server-side.
