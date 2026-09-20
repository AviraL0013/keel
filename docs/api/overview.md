# API

Public:

- `GET /health`
- `GET /ready`
- `GET /metrics`
- `POST /auth/challenge`
- `POST /auth/verify`
- `POST /auth/logout`

Authenticated:

- `GET /books`
- `POST /books` (supports `marketId`, `venueAccountId`, `venuePositionId`)
- `GET /books/:id`
- `GET /books/:id/position`
- `GET /books/:id/telemetry`
- `GET /books/:id/risk`
- `PATCH|POST /books/:id/controls`
- `POST /books/:id/arm`
- `POST /books/:id/pause`
- `POST /books/:id/kill`
- `POST /books/:id/close`
- `GET /connections`
- `POST /connections/perpl`
- `POST /connections/perpl/validate`
- `POST /connections/revoke`
- `POST /devices`
- `GET /notifications`
- `POST /notifications/:id/read`
- `GET /books/:id/decisions`
- `GET /books/:id/actions`
- `GET /books/:id/reserve`
- `GET /books/:id/autopsy`

`POST /books/:id/close` enters the server execution worker. It returns `503` only when live execution is not configured; it never claims a position closed without reconciliation.

Book ownership is checked server-side. Financial execution never occurs in React event handlers. Live Perpl credentials and PostgreSQL are external activation requirements.

