# Implementation status

## Current architecture

- TypeScript modular monolith with Fastify interfaces, application ports/use cases, deterministic domain/risk packages, PostgreSQL repositories, Perpl adapters, Monad/AUSD/Agora adapters, runtime monitoring, execution reconciliation, reserve ledger, Autopsy, notifications, auth, and fail-closed readiness.
- Flutter mobile client under `apps/mobile/lib` with Riverpod, secure session storage, API client, feature repositories, Book dashboard, positions, capital, Autopsy, notifications, settings, and wallet challenge/signature flow.
- Replay and failure injection remain test-only adapters.

## Verified locally

- 2026-09-28: `npm test`: 248 tests passing across 42 files.
- `npm run lint`: passing.
- `npm run typecheck`: passing.
- Flutter 3.47.5 / Dart 3.13.4: `flutter analyze` clean; `flutter test` 50 tests passing.

## External requirements

Live readiness still requires PostgreSQL, Perpl credentials and approvals, Monad/AUSD account access, Agora configuration where used, and push provider credentials. Local tests used fake venues and did not contact external services.
