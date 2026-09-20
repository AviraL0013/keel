# Demo

Run the explicit local test venue with `KEEL_ENV=test KEEL_TEST_VENUE=true`. The Flutter app then talks to the real HTTP API, application services, deterministic venue, in-memory persistence, risk engine, execution worker, and reconciliation path. It is labeled `DEV / TEST VENUE`; it is not a live testnet.

The deterministic replay engine demonstrates healthy HOLD, floor breach DEFEND, low reserve REDUCE, liquidity collapse EXIT, inefficient-defense refusal, stale SAFE_MODE, time expiry, KILL, short positions, and execution UNKNOWN. Replay never reports venue confirmation.

Live proof requires Perpl testnet account state, signed trading WS, forwarding authorization, Monad/AUSD evidence, and external transaction/order references.
