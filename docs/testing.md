# Testing

Run backend gates:

```powershell
npm run lint
npm run format:check
npm test
npm run typecheck
npm run build
npm run smoke:prod
```

Tests use PGlite, deterministic replay, memory stores, and explicit venue adapters. They cover risk states, defense sizing, stale telemetry, rescue refusal, Book lifecycle, ownership, execution outcomes, reserve transactionality, Perpl normalization, monitoring, and auth.

Run Flutter checks when Flutter SDK is installed:

```powershell
cd apps/mobile
flutter pub get
flutter analyze
flutter test
```

Live Perpl and PostgreSQL smoke checks require external testnet credentials and reachable services. They never substitute replay data for live execution.

## Public analytics contract replay

With Node dependencies and the pinned Flutter SDK installed, run:

```powershell
cd apps/mobile
flutter test tool/analytics_server_contract_test.dart --reporter expanded
```

This starts a local Fastify replay listener and the real public Flutter client against recorded fixtures. It does not start a trading worker, connect a live venue, read credential custody, or access a production database. It checks public route composition, wallet parsing, precision and unavailable values, plus private-route rejection. Recorded or illustrative fixtures are not fresh live values.

All five CI validation jobs must pass before an authorized main merge: backend validation, Flutter, Android, container and secret scan. Web deployment runs after those gates. For documentation-only changes, local proof checks links and the changed-file boundary; a full application test run adds no documentation-specific coverage.
