# Testing

Run backend gates:

```powershell
npm run lint
npm test
npm run typecheck
npm run server:typecheck
npm run build
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
