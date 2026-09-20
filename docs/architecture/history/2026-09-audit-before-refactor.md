# Audit snapshot before refactor

# Repository audit

## Runtime map

- `server/src/index.ts` is the Fastify composition root and currently contains all HTTP routes, validation, auth lookup, raw SQL reads, response shaping, runtime setup, and error mapping.
- `server/src/runtime.ts` owns monitoring, advisory locks, risk evaluation, action creation, and worker lifecycle.
- `server/src/worker.ts` owns action submission, reconciliation, reserve settlement, Autopsy events, and notifications through a broad repository contract.
- `server/src/store.ts` combines PostgreSQL pool setup, Book persistence, positions, telemetry, decisions, actions, reserve, Autopsy, sessions, connections, and devices.
- `server/src/perplRuntime.ts` composes Perpl, Monad, AUSD, and Agora adapters into a venue runtime.

## Dependency direction observed

```text
React web (`src`) -> source-path wrappers -> packages/domain, packages/risk-engine, server worker
Expo mobile (`apps/mobile/App.tsx`) -> fetch + SecureStore + duplicated DTOs
Fastify (`server/src/index.ts`) -> store, auth, runtime, Perpl runtime, domain types
runtime/worker/store -> packages/domain, packages/risk-engine, packages/perpl
packages/perpl -> packages/domain, shared HTTP, ws, decimal.js
packages/risk-engine -> packages/domain, decimal.js
packages/chain -> viem
packages/ausd -> chain + domain
packages/persistence -> domain types only (contracts unused by server)
```

## Domain logic

`packages/domain/src/index.ts` contains shared entities and value-like types. `packages/risk-engine/src/index.ts`, `policy.ts`, and `sizing.ts` contain deterministic risk, policy, liquidation distance, and defense sizing. `packages/perpl/src/marketDecoder.ts` and `units.ts` normalize vendor data.

## Application logic

Application orchestration is implicit in `runtime.ts`, `worker.ts`, and route handlers. No explicit use-case layer exists. `packages/persistence` defines a small repository contract but server uses a larger concrete `Store` interface instead.

## Infrastructure

Perpl adapters live in `packages/perpl`; Monad/AUSD/Agora in `packages/chain` and `packages/ausd`; PostgreSQL in `server/src/store.ts` and `notificationStore.ts`; replay/memory adapters are mixed with production-facing modules.

## Interfaces

Fastify routes are all in `server/src/index.ts`. DTOs are inline request/response shapes. Raw database rows are returned by position, telemetry, risk, connection, and notification routes. No API contract package exists.

## Frontend

`src` is a Vite React operator surface. `apps/mobile` is Expo/React Native with a single 15 KB `App.tsx`, inline API client, storage, auth, navigation, DTOs, and presentation. `apps/mobile/index.web.ts` mounts the web React app, creating a second product path.

## Tests

47 tests cover risk, lifecycle, persistence, Perpl decoders/history/market/units, monitor, execution, reserve settlement, replay, and server auth/API behavior. Tests import source packages directly and use PGlite/memory adapters.

## Duplicate/dead candidates

- `src/riskEngine.ts`, `src/perpl.ts`, `src/backend.ts`, `src/ausd.ts`, and `src/types.ts` are web compatibility wrappers, not authoritative domain/application modules.
- `packages/policy-engine` re-exports one risk policy function without an independent boundary.
- `packages/persistence` contracts are not used by concrete server repositories.
- Expo `index.web.ts` embeds the web app as a mobile target; mobile owns a separate implementation in `App.tsx`.
- `dist`, root TypeScript build info, and installed dependency trees are local artifacts.
- Root docs duplicate status and setup facts across several files.

## Refactor order

1. Preserve gates and safety behavior.
2. Add explicit server config, errors, ports, application use cases, and HTTP route modules.
3. Move concrete persistence and runtime adapters behind those boundaries without changing SQL or policy.
4. Add stable response DTO mappers.
5. Replace Expo app with Flutter feature-first shell and API client; retain old Expo only until Flutter path is verified, then remove obsolete files.
6. Update docs and ignore generated artifacts.

