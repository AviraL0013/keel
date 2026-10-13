# Development

## Prerequisites

- Node.js 22 (the CI version)
- npm 10 or newer
- PostgreSQL 15 or newer for persistent runtime tests
- Flutter 3.47.5 (the CI version) for mobile work

Install dependencies and configure environment:

```powershell
npm ci
copy .env.example .env
npm run db:migrate
```

Set `DATABASE_URL` and `SESSION_SECRET`. Perpl, Monad, AUSD, Agora, and push credentials stay server-side. Deterministic tests do not require live credentials.

For a credentialless sandbox, set `EYELER_ENV=test` and `EYELER_TEST_VENUE=true`, leave live credentials and `DATABASE_URL` unset, and skip the migration. Its in-memory state resets on restart. Do not run a second live backend against the deployed trading account.

## Processes

```powershell
npm run server:dev
cd apps/mobile
flutter pub get
flutter run --dart-define=EYELER_API_URL=http://localhost:8787
```

`/health` reports process health. `/ready` fails closed unless PostgreSQL, runtime worker, and venue are ready.

Local PostgreSQL data remains in its Docker volume when the process stops. A sleeping laptop does not continue indexing or monitoring. Hosted workers are separate from local development. Persistent UNKNOWN or PARTIAL actions must be reconciled; restarting is not permission to resend them.
