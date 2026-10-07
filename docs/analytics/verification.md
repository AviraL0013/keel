# Analytics verification, 2026-10-07

All chain actions below were read-only. The local backfill used an in-memory PostgreSQL instance and bounded log ranges. No production database was changed.

## Recent mainnet sample

An initial three-chunk run started at block `111382224` while the head was `111382276`. It indexed 81 raw Exchange events, including 23 maker fills with derived notional `578.754014` AUSD. After the automatic seven-day start was implemented, a second three-chunk run located start block `109385344` at head `111387262`, then advanced to `109385404`. Its 60-block sample contained 169 raw events, 30 maker fills and `2,903.759788` AUSD of maker notional. Neither sample contained a deposit or liquidation event. That does not imply zero flows or liquidations in a full day or week. The dedicated worker continues the same 20-block chunks from its persisted checkpoint; the in-memory sample script stops after three chunks. A complete seven-day backfill still requires a persistent database and RPC environment configuration.

The public RPC returned HTTP 413 for a single genesis-to-head log request. Small 20-block ranges succeeded. A historical state read returned `RPC_-32602`, so the public provider has not demonstrated archive coverage. The user supplied the Exchange creation transaction `0x22d1d74e137c3a82ac4b702fd90024811b184fcdcf8fd4d1473097b4d8a619f3` at block `54773010`; an archive RPC must verify and replay from there before all-time completeness is claimed.

## Independent Perpl comparison

At `2026-10-07T17:05:52Z`, Perpl public context reported BTC 24h volume of `11,707,068.249030` AUSD. Summing 25 returned hourly candle volumes over the nearby request interval gave `11,728,293.792658` AUSD, a difference of `21,225.543628` AUSD (`0.1813%` of the context value). The sources use separately observed rolling windows. The exact cause of the difference is unverified. Do not use the candle sum as an exact reconciliation of the context snapshot.

A finalized public view call for an observed wallet returned balance `1,412,452.711716` AUSD and 11 open positions at block `111379026`. A separate 20-block Exchange log query returned 25 events, of which four were derived maker fills. These checks establish connectivity and decoder behavior for a small sample, not full historical completeness.

## Latency

The offline cached `/markets` load check ran 400 requests at concurrency 20 with p95 `3.81 ms`, under the documented local target of 250 ms. It excludes network and cold database latency. Production p95 and a complete 7 to 30 day backfill are unverified.
