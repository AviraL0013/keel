# Eyeler

Eyeler watches a leveraged position against a reserve and clear risk limits. When conditions change, it chooses HOLD, bounded DEFEND, reduce-only REDUCE or EXIT, then checks Perpl before calling the action complete. If market data or execution evidence is uncertain, it pauses new orders and shows why.

The repository implements Android Mera-compatible passkey wallets, owner-bound encrypted Perpl credentials, Monad mainnet AUSD activation, explicit opening orders, and opt-in position protection. Mainnet is an allowlisted demo profile; testnet operator and credentialless sandbox profiles remain separate. Deployment and device evidence is recorded in the [Agora journey](docs/product/agora-submission.md); historical checkpoints are not proof that the latest candidate is deployed.

For the **Best Use of Perpl's API** bounty, the mounted automation product is the Book protection bot, not the paper GRID or market maker. See the [Perpl submission and two-minute demo guide](docs/product/perpl-submission.md) for implementation, reliability tests, evidence requirements and remaining release gates. No guaranteed profitability or award claim is made.

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

Automatic actions require an active, explicitly armed Book, fresh telemetry, sufficient reserve/cap/headroom and execution enabled. Manual actions require their own explicit authorization. Both paths recheck policy and connection authorization immediately before sending. REDUCE and EXIT are reduce-only. An UNKNOWN or PARTIAL outcome is reconciled, never blindly resubmitted. Pause and kill controls stop automation.

Request identity and the exact execution deadline are persisted before socket submission. Interrupted new attempts with no durable reference can be fenced and their Book paused; referenced, ambiguous and legacy attempts cannot be reclaimed just because they are old. Per-user mode binds each Book and credential to its owner/account; operator mode retains its single-wallet restriction.

`/health` only proves the HTTP process is alive. `/ready` also checks the database, venue, monitor ownership, latest completed tick and execution readiness; it reports when the emergency stop is on. Before deploying, follow the [deployment guide](docs/deployment/deploy.md) and the relevant [mainnet rollout plan](docs/deployment/mainnet-bounty.md). Run reports separate manual, automatic and historically unattributed attempts, and execution deadlines from confirmed blocks. They do not independently verify stored receipts or establish net profit; see the [report procedure](docs/product/perpl-submission.md#export-and-check-evidence).
