# Legacy architecture snapshot

# Architecture

`src` provides web control surface. `apps/mobile` provides native control surface and consumes server APIs. `server` owns auth, Book lifecycle, scheduler, execution, reconciliation, persistence, notifications, and Autopsy.

- `packages/domain`: pure Book, position, reserve, decision, action, and event types.
- `packages/risk-engine`: deterministic feature derivation, bounded sizing, policy classification, defense measurement, replay, failure injection.
- `packages/policy-engine`: policy boundary exported separately from risk calculations.
- `packages/perpl`: official REST/WS config, signed history, market stream, trading WS, protocol decoders, normalization, order construction, evidence reconciliation.
- `packages/chain`: Monad RPC and ERC-20 reads.
- `packages/ausd`: AUSD balance/reserve reconciliation boundary.
- `packages/persistence`: repository contracts.
- `database/migrations`: PostgreSQL schema and invariants.
- `server/src/runtime.ts`: PostgreSQL advisory-lock scheduler and restart-safe monitoring loop.

Flow:

`Perpl WS/REST -> decode -> normalize -> risk snapshot -> deterministic policy -> action record -> worker -> signed venue action -> history/state reconciliation -> reserve/Autopsy/notification -> mobile`

Production decisions and execution remain server-side. Demo/replay adapters never masquerade as live success.

