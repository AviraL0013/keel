# Analytics verification, 2026-10-07

All chain actions below were read-only. The local backfill used an in-memory PostgreSQL instance and bounded log ranges. No production database was changed.

## Recent mainnet sample

An initial three-chunk run started at block `111382224` while the head was `111382276`. It indexed 81 raw Exchange events, including 23 maker fills with derived notional `578.754014` AUSD. After the automatic seven-day start was implemented, a second three-chunk run located start block `109385344` at head `111387262`, then advanced to `109385404`. Its 60-block sample contained 169 raw events, 30 maker fills and `2,903.759788` AUSD of maker notional. Neither sample contained a deposit or liquidation event. That does not imply zero flows or liquidations in a full day or week. The dedicated worker continues the same 20-block chunks from its persisted checkpoint; the in-memory sample script stops after three chunks. A complete seven-day backfill still requires a persistent database and RPC environment configuration.

The public RPC returned HTTP 413 for a single genesis-to-head log request. Small 20-block ranges succeeded. A historical state read returned `RPC_-32602`; that failure concerns historical state, not historical event logs.

On 2026-10-08, an unsigned receipt query confirmed that Exchange creation transaction `0x22d1d74e137c3a82ac4b702fd90024811b184fcdcf8fd4d1473097b4d8a619f3` succeeded at block `54773010` and created the pinned Exchange address. A 1,000-block log query was rejected with RPC code `-32614`, message `eth_getLogs is limited to a 100 range`. A correctly bounded query for blocks `54773010`–`54773109` returned 21 logs in 1.678 seconds, including the creation transaction. This proves deployment-era log availability for that sample. It does not prove uninterrupted history or enough throughput for a complete replay.

The API now requires the verified deployment start, fresh included block timestamps and a caught-up checkpoint before claiming complete history. Regression tests reject partial performance totals, recent-start all-time claims, malformed recognized events and incomplete chart buckets. Fully covered chart buckets remain visible while the uncovered tail is null.

## Independent Perpl comparison

At `2026-10-07T17:05:52Z`, Perpl public context reported BTC 24h volume of `11,707,068.249030` AUSD. Summing 25 returned hourly candle volumes over the nearby request interval gave `11,728,293.792658` AUSD, a difference of `21,225.543628` AUSD (`0.1813%` of the context value). The sources use separately observed rolling windows. The exact cause of the difference is unverified. Do not use the candle sum as an exact reconciliation of the context snapshot.

A finalized public view call for an observed wallet returned balance `1,412,452.711716` AUSD and 11 open positions at block `111379026`. A separate 20-block Exchange log query returned 25 events, of which four were derived maker fills. These checks establish connectivity and decoder behavior for a small sample, not full historical completeness.

## Read-only comparison, 2026-10-08

At `2026-10-08T08:13:57.337Z`, unsigned Perpl context at block `111559471` reported BTC 24-hour volume `12,445,852.544367` AUSD. The separate request returned 24 hourly candles totaling `11,892,643.636495` AUSD, lower by `553,208.907872` AUSD. Request edges, response observations and rolling-window definitions differ; the exact source of this discrepancy is unverified. These figures are not a reconciliation or a complete archive proof.

The configured analytics RPC was absent, so the documented public Monad RPC was used for this recent read. Wallet view at head-minus-12 block `111559479` returned balance `1,405,007.410891` AUSD and 11 open positions. The unsigned 21-block range `111559462`–`111559482` returned 68 raw Exchange events and 18 derived maker fills, with no observed collateral flow event. This confirms a small recent sample only, not zero daily flows. No history was written to production, and no signed Perpl request, transaction or order was sent.

The new offline recovery test replays 1,000 **synthetic transport blocks** with the existing recorded logs, including a failed chunk, restart and 64-block rewind. It proves checkpoint and idempotency mechanics. Synthetic intervening headers/ranges do not establish continuous mainnet coverage, RPC throughput or a complete historical replay. Wrong-chain and mid-read boundary reorg failures were reproduced before adding chain checks and the final boundary reread.

## Finalized wallet and entry precision regressions, 2026-10-08

Fake-RPC tests now prove one finalized snapshot, address/ID roundtrips, matching account bitmaps, canonical hash rereads, source timestamps, cache freshness, context changes, wrong-chain/finality refusal and incomplete position coverage. SDK-derived bitmap vectors cover bank-one non-position bits, wrong membership and the 253 boundary. Equity includes position collateral; unavailable balance clamps at zero when order locks exceed account balance. Recorded market-100 short entry is `5.15296234588623046875`, preserving Q16 residue instead of truncating to `5.1529`. The recorded payload contains one position while its account bitmap contains eleven; whole-wallet equity is therefore unavailable. The Node-to-Flutter loopback test retains the exact entry and null equity.

These are offline correctness checks, not a new verified mainnet RPC snapshot. The old payload has no snapshot-block hash; its entry-block hash is not substituted for that missing proof. The finalized transport fixture uses synthetic headers. An initial red test accidentally constructed the real transport against `rpc.invalid` because the injected client did not exist yet; DNS failed with `ENOTFOUND`. The harness now forbids global fetch and asserts it was never called. No credentials or real venue action were involved.

## Latency

The offline cached `/markets` load check ran 400 requests at concurrency 20 with p95 `3.81 ms`, under the documented local target of 250 ms. It excludes network and cold database latency. Production p95 and a complete 7 to 30 day backfill are unverified.
