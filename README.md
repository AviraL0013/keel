# Eyeler

Eyeler watches a leveraged position against a reserve and clear risk limits. When conditions change, it chooses HOLD, bounded DEFEND, reduce-only REDUCE or EXIT, then checks Perpl before calling the action complete. If market data or execution evidence is uncertain, it pauses new orders and shows why.

The existing live deployment is the restricted testnet operator build. This repository also implements the Agora bounty candidate: native Mera passkey wallets, per-user encrypted Perpl credentials, mainnet AUSD activation, confirmed opening trades, and guided onboarding. Device passkey ceremonies and a real mainnet demo trade still require release verification; implementation is not a claim about the current deployment. See the [submission journey and demo guide](docs/product/agora-submission.md) and [mainnet rollout plan](docs/deployment/mainnet-bounty.md).

| Capability | Live testnet | Public sandbox |
| --- | --- | --- |
| Wallet challenge and session | Real wallet signature | Real wallet signature |
| Market, position and account state | Signed Perpl/Monad reads | Deterministic fake venue |
| Risk decisions and limits | Same deterministic engine | Same deterministic engine |
| DEFEND, REDUCE and EXIT | Perpl testnet submission and reconciliation | Simulated execution, clearly labeled |
| Autopsy and run report | PostgreSQL evidence | In-memory evidence, lost on restart |
| Capital and Agora | Separate wallet, Perpl and Book balances; read-only Agora activity and optional global AUSD supply | Fake venue balances; Agora unavailable unless configured |
| Telegram | Optional operator-only alerts | Off |

The Flutter app calls Fastify over HTTPS. The server owns authentication, the one-second monitor, policy and execution; PostgreSQL holds Books, actions, snapshots and evidence. The Perpl adapter handles REST/WS state and submissions. Monad supplies the signed-in wallet's collateral-token balance (testnet USD; mainnet AUSD). Capital keeps wallet, Perpl free/locked and Book allocations separate, and warns when available Book reserves exceed Perpl free balance. Agora activity and optional global AUSD supply are informational only. The client obtains the user's explicit order confirmation; the server independently validates whether an order may execute.

## Try it locally

Use Node 22 and Flutter 3.19 or newer. Copy only the example configuration; never commit a real `.env` file.

```bash
npm ci
cp .env.example .env
# For PostgreSQL mode, set DATABASE_URL in this shell first.
npm run db:migrate
npm run server:dev
```

```powershell
npm ci
Copy-Item .env.example .env
# For PostgreSQL mode, set $env:DATABASE_URL in this shell first.
npm run db:migrate
npm run server:dev
```

For a credentialless sandbox, skip the migration, set `EYELER_ENV=test` and `EYELER_TEST_VENUE=true`, then start the server. It uses memory storage and makes **no live venue orders**.

```bash
EYELER_ENV=test EYELER_TEST_VENUE=true npm run server:dev
```

```powershell
$env:EYELER_ENV='test'
$env:EYELER_TEST_VENUE='true'
npm run server:dev
```

Run the Flutter web client on a chosen port:

```bash
cd apps/mobile
flutter pub get
flutter run -d web-server --web-port 8082 --dart-define=EYELER_API_URL=http://localhost:8787
```

```powershell
Set-Location apps/mobile
flutter pub get
flutter run -d web-server --web-port 8082 --dart-define=EYELER_API_URL=http://localhost:8787
```

`npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run build`, `npm run smoke:prod` and `npm test` check the backend. In `apps/mobile`, run `flutter analyze` and `flutter test`.

## Safety in plain words

Eyeler sends no order when telemetry is stale or invalid, a policy refuses it, automation is off, an action is unresolved, or `EYELER_EXECUTION_DISABLED=true`. A DEFEND cannot exceed the reserve, cap or headroom. REDUCE and EXIT are reduce-only. An UNKNOWN or PARTIAL outcome is reconciled, never blindly resubmitted. Pause and kill controls stop automation. The server rejects live Perpl startup with more than one allowed wallet because the trading account is still server-wide.

`/health` only proves the HTTP process is alive. `/ready` also checks the database, venue, monitor ownership, latest completed tick and execution readiness; it reports when the emergency stop is on. Before deploying, run the [deployment guide](docs/deployment/deploy.md) and [rebrand rollout](docs/deployment/eyeler-rebrand.md). A one-hour evidence file can be produced with `npm run report -- --from <iso> --to <iso>`.

## Known limits and demo

This build requires one backend instance and one live Perpl operator wallet. Android/iOS native WalletConnect, per-user trading connections, production KMS custody and composable contracts are future work. The Perpl enrollment screen also awaits origin whitelisting. Sandbox outcomes are simulations; live confirmations require real testnet evidence. Follow the [scripted demo](docs/demo.md) and inspect the [audit](docs/audit/pre-deploy-audit.md).

- App: **[add public URL after deploy]**
- Sandbox: **[add public URL after deploy]**
- Demo video: **[add link]**
- One-hour run report: **[add link]**
