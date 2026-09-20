# Architecture overview

Book lifecycle uses one dependency direction:

```text
HTTP / Flutter
      |
Application use cases
      |
Domain + deterministic risk engine
      |
Ports
      |
PostgreSQL / Perpl / Monad / AUSD / Agora adapters
```

`server/src/interfaces/http` validates requests, authenticates sessions, calls application services, and serializes DTOs. `server/src/application` coordinates repositories and venue ports. Domain and risk code receive normalized values only. Infrastructure owns SQL, vendor wire formats, WebSocket state, RPC, and external credentials.

The persistent Perpl stream is shared by Books. It publishes normalized market, funding, orderbook, freshness, and connection state. Execution records gateway submission separately from authoritative reconciliation and preserves `UNKNOWN` outcomes.

Flutter uses `KeelApiClient`, feature repositories, and Riverpod providers. It renders `RiskDecision` and telemetry from API responses. It does not reproduce liquidation thresholds, defense sizing, rescue refusal, or action policy.
