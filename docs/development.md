# Development

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- PostgreSQL 15 or newer for persistent runtime tests
- Flutter 3.19 or newer for mobile work

Install dependencies and configure environment:

```powershell
npm ci
copy .env.example .env
npm run db:migrate
```

Set `DATABASE_URL` and `SESSION_SECRET`. Perpl, Monad, AUSD, Agora, and push credentials stay server-side. Deterministic tests do not require live credentials.

## Processes

```powershell
npm run server:dev
cd apps/mobile
flutter pub get
flutter run --dart-define=KEEL_API_URL=http://localhost:8787
```

`/health` reports process health. `/ready` fails closed unless PostgreSQL, runtime worker, and venue are ready.
