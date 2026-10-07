# Local mobile-to-API replay

This proof uses the real `PublicAnalyticsClient` and `HttpAnalyticsRepository` against a Fastify listener on `127.0.0.1`, with the complete HTTP route registration and session hook. It does not start a trading worker, connect a venue, access credential custody, or call a production database. Public Perpl context/funding/candle responses and Exchange views come from the recorded mainnet fixtures.

Run from a checkout with Node dependencies and the pinned Flutter SDK installed:

```powershell
cd apps/mobile
flutter test tool/analytics_server_contract_test.dart --reporter expanded
```

The test starts its own temporary replay process and shuts it down. Both SDKs are required, so this explicit integration command is separate from the Node-only and Flutter-only CI jobs. It is not a skipped test in either suite.

The replay persists one actual recorded Exchange block through the decoder and SQL repository. It preserves the block timestamp and incomplete-history status. The wallet snapshot remains archived and stale. Unknown liquidation prices, complete-history performance and unobserved wallet trades remain unavailable. No fresh balance, full backfill or profitability is claimed.

Assertions cover protocol composition, market lookup, wallet search, exact six-decimal balance and locked/free margin, short position and PnL, null liquidation/performance values, trade-page parsing and private `/books` rejection. A request containing fractional microseconds exercises the canonical millisecond query boundaries. The public client refuses private paths before issuing HTTP.

The new integrated regression reproduced unsigned `/analytics/v1/markets` returning HTTP 401 because the parent session hook also applied to the analytics child plugin. The fix exempts only registered GET routes under `/analytics/v1/`; Books, Capital, strategies, openings, POST requests and lookalike URLs still require authentication.

For the recorded position, an unsigned `eth_getBlockByNumber` request to the public Monad RPC verified entry block `111376310` (`0x6a377b6`), hash `0x8e4559c02a16e9404f6dfd76f65af3e7c833bf1fddb515fa35ad56c530c3f7ce` and timestamp `2026-10-07T16:52:08.000Z`. The replay validates that evidence against the recorded position's entry block instead of using capture time as an opening time.

The local listener/client test passes. Production API integration, sustained replay throughput, seven-day/all-history coverage and real-device rendering remain unverified.
