# Implementation status

## Current architecture

- TypeScript modular monolith with Fastify interfaces, application ports/use cases, deterministic domain/risk packages, PostgreSQL repositories, Perpl adapters, Monad/AUSD/Agora adapters, runtime monitoring, execution reconciliation, reserve ledger, Autopsy, notifications, auth, and fail-closed readiness.
- Flutter mobile client under `apps/mobile/lib` with Riverpod, secure session storage, API client, feature repositories, Book dashboard, positions, capital, Autopsy, notifications, settings, and wallet challenge/signature flow.
- Replay and failure injection remain test-only adapters.

## Verified locally

- `npm test`: 47 tests passing across 15 files.
- `npm run lint`: passing.
- `npm run typecheck`: passing.
- `npm run server:typecheck`: passing.
- `npm run build`: passing.

## External requirements

Live readiness still requires PostgreSQL, Perpl credentials and approvals, Monad/AUSD account access, Agora configuration where used, and push provider credentials. Flutter analyze/test/build require a Flutter SDK; this environment has no Flutter executable, so those gates remain external.
