# EYELER

EYELER is programmable risk operations for isolated leveraged onchain positions. A Book combines position, reserve, risk constraints, live telemetry, bounded actions, execution verification, and Autopsy evidence. The deterministic server policy returns `HOLD`, `DEFEND`, `REDUCE`, `EXIT`, or `SAFE_MODE`.

## Architecture

EYELER is a modular monolith.

```text
Flutter mobile
    | HTTPS
Fastify HTTP interfaces
    | use cases and ports
Application services
    | pure inputs
Domain and risk engine
    | adapters
PostgreSQL | Perpl REST/WS | Monad | AUSD | Agora
```

- `server/src/application`: use-case orchestration, ports, and error model.
- `server/src/interfaces/http`: thin Fastify route registration and DTO mappers.
- `server/src`: runtime, workers, authentication, and infrastructure wiring. Concrete PostgreSQL repositories live under `server/src/infrastructure/database`.
- `packages/domain`: domain types with no venue or framework dependency.
- `packages/risk-engine`: deterministic risk features, policy, and defense sizing.
- `packages/perpl`: vendor wire decoding, normalization, persistent market stream, trading, and reconciliation.
- `packages/chain` and `packages/ausd`: Monad, AUSD, and Agora integration boundaries.
- `packages/notifications`: push provider port and provider adapters.
- `database/migrations`: PostgreSQL schema and invariants.
- `apps/mobile`: Flutter feature-first client with Riverpod repositories, typed models, secure auth storage, Book configuration/review, dashboard, capital, Autopsy, notifications, and settings. It displays backend decisions and never calculates risk authority.
- `tests`: unit, stateful, integration, and adapter tests.

## Local setup

```powershell
npm install
copy .env.example .env
npm run db:migrate
npm run server:dev
```

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run server:dev
```

Set `EYELER_ALLOWED_WALLETS` to the wallets allowed to sign in, or set `MONAD_WALLET_ADDRESS` as the fallback. Testnet/mainnet browser requests must come from an origin listed in `CORS_ORIGIN`; development/test accept any origin.

Existing installations should follow the [rebrand rollout](docs/deployment/eyeler-rebrand.md). Keep the current PostgreSQL database and its execution history; previous `KEEL_*` settings remain accepted during the transition.

For a credentialless end-to-end local run, use the explicit deterministic venue. It is a real HTTP/application path backed by the in-memory test store and the production risk/execution code; it never masquerades as live Perpl:

```powershell
$env:EYELER_ENV='test'
$env:EYELER_TEST_VENUE='true'
$env:PORT='8787'
npm run server:dev
```

```bash
export EYELER_ENV=test
export EYELER_TEST_VENUE=true
export PORT=8787
npm run server:dev
```

The Flutter client defaults to `http://localhost:8787`; override it with `--dart-define=EYELER_API_URL=...`. The local venue is labeled `DEV / TEST VENUE` in the client. A browser EVM wallet provider is still required for the real challenge/signature flow. PostgreSQL and live Perpl credentials are optional for deterministic tests; without them `/ready` remains fail-closed.

## Checks

```powershell
npm run lint
npm test
npm run typecheck
npm run server:typecheck
npm run build
```

```bash
npm run lint
npm test
npm run typecheck
npm run server:typecheck
npm run build
```

Flutter development requires Flutter SDK 3.19 or newer:

```powershell
cd apps/mobile
flutter pub get
flutter analyze
flutter test
flutter run --dart-define=EYELER_API_URL=http://localhost:8787
```

```bash
cd apps/mobile
flutter pub get
flutter analyze
flutter test
flutter run --dart-define=EYELER_API_URL=http://localhost:8787
```

## API

Auth: `POST /auth/challenge`, `POST /auth/verify`, `POST /auth/logout`.

Books: `GET /books`, `POST /books`, `GET /books/:id`, `GET /books/:id/position`, `GET /books/:id/telemetry`, `GET /books/:id/risk`, `POST /books/:id/actions`, `POST /books/:id/{arm,pause,kill,close}`.

Operations: `GET /capital`, `POST /connections/perpl/validate`, `GET /connections/perpl/positions`, `GET /books/:id/autopsy`, `GET /notifications`, `POST /notifications/:id/read`.

Development-only controls: `POST /dev/test-venue/scenario` with `healthy`, `floor-breach`, `deterioration`, or `stale` when `EYELER_ENV=test` and `EYELER_TEST_VENUE=true`. `POST /controls/kill-switch` disables automation on every Book owned by the authenticated wallet.

All protected routes require the server session. Perpl secrets, reserve authority, risk decisions, and execution state stay server-side.

## Modes

Replay and failure injection are test adapters. Production never falls back from an unavailable live venue to replay data.
