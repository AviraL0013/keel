# Perpl Analytics historical ingestion evidence

Date: 2026-10-11. Branch: `feat/analytics-history`. Scope: Exchange logs from verified creation block `54773010` to a fresh head minus 12 confirmations. No production database, Railway service, transaction, signature, or private RPC was used.

## Read-only public RPC checks

Source: `https://rpc.monad.xyz`, chain 143. Requests used `eth_blockNumber`, `eth_getLogs`, and `eth_getBlockByNumber`. Logs were filtered to the pinned Exchange address and the official SDK event selectors. No signed or authenticated method was called.

| Range start | 100-block filtered logs | Five 20-block reads | Same log identities? |
| ---: | ---: | --- | --- |
| 54,773,010 | 3 | 3, 0, 0, 0, 0 | Yes |
| 70,000,000 | 34 | 2, 10, 2, 12, 8 | Yes |
| 90,000,000 | 594 | 144, 150, 144, 96, 60 | Yes |
| 112,396,000 | 228 | 56, 40, 38, 32, 62 | Yes |

The deployment range contained all three recorded creation-transaction Exchange logs: `Upgraded` at log index 28, `ExchangeInitialized` at 30, and `Initialized` at 31. A 100-header JSON-RPC batch returned `-32007` for entries after the first 20. A 20-header batch succeeded. This establishes sampled historical log availability and the practical header-batch bound. It does not establish that every interval across 57.6 million blocks is available or complete.

## Local replay and throughput

An earlier, unbatched local replay of three 20-block ranges at block 90,000,000 took 5.713, 4.129, and 3.577 seconds per chunk. It inserted 438 raw logs. After batching headers in groups of 20 and growing successful log ranges from 20 up to 100 blocks, a read-only public RPC replay into an in-memory PostgreSQL/WASM database covered **2,020 consecutive blocks** starting at 90,000,000. It stored **9,635 raw logs** in **107.190 seconds**, including 100 ms pacing after each successful chunk and three `-32007` errors recovered with 1, 2, and 4 second backoffs. Measured rate: **18.85 blocks/s**. The test database was local and disposable; it was not production PostgreSQL.

At a later read, public head was **112,399,457**, leaving **57,626,447 blocks** from Exchange creation through that head. Extrapolating the measured local rate gives about **35.4 days** to a fixed head. Head advanced about 2.5 blocks/s during this session; if that rate persists, catch-up would take about **40.8 days**. These are rough capacity estimates, not a promised full-backfill duration. Event density, database speed, rate limits, outages, and archive retention vary by era. A 2,020-block sample is not a continuous deployment-to-head replay.

The public RPC serves sampled old logs, but this rate is not useful for a short operational backfill. A sustained, higher-throughput archival log source and a durable worker/database slot are needed to finish deployment-to-head coverage in a practical window. The existing Railway trial project was already at its documented five-service limit; this branch makes no hosting changes.

## Coverage rules and recovery

Migration 035 downgrades old `history_verified` flags, because older workers set them when configured at deployment before replay. A proof-version column makes that one-time downgrade safe on migration reruns. New runs leave the flag false until the deployment-start checkpoint reaches a fresh confirmed head. The promotion query requires the last stored hash and timestamp plus all three recorded creation-transaction logs. Rewind and an earlier configured start clear the flag. The HTTP route already requires this flag, deployment start, first indexed block, and fresh coverage before showing `All time`; no route change was made.

The worker keeps the existing atomic chunk checkpoint and 64-block reorg rewind. It now batches header reads at the observed 20-entry RPC limit, grows log ranges only after three successful chunks, caps them at 100, and halves the range on HTTP 413 or RPC `-32614`. Other failures use the existing bounded run-loop backoff; HTTP 401/403 remains fatal. It rejects out-of-range and removed logs, conflicting duplicate identities, incomplete header batches, and a missing deployment anchor before advancing. Exact duplicate logs are stored once. Repository calls reject mismatched endpoints, unordered headers, and spans above 100 blocks.

Offline fake-RPC and recorded-public-log tests cover restart, adaptive range refusal, missing deployment logs, out-of-range logs, duplicate and conflicting events, incomplete header batches, HTTP 403, same-chunk boundary changes, and reorg rewind. No test contacts the network. A single provider's `eth_getLogs` response is still trusted for interior log completeness; the four split-range comparisons above are samples, not a chain-wide audit. No `completeHistory` claim is warranted until a durable replay runs continuously from block 54773010 to a fresh confirmed head, with checkpoint and source monitoring throughout.

Local lint, format, production typecheck, build, smoke, and seven focused indexer/history tests passed. The full Node suite ran 828 tests in 139 files: 827 passed, and one existing `analytics-coverage.test.ts` fixture failed. That fixture manually restores checkpoint fields after calling `rewind()` and still expects `completeHistory=true`. Rewind now correctly clears historical completion. The fixture is outside this branch's edit ownership and needs its owner to model an actual deployment-to-head replay or expect incomplete coverage. This is a gate blocker, not evidence that history is complete.

## Integration needed

1. Provide a read-only chain-143 RPC with complete Exchange logs from block 54773010, a documented 100-block (or better) log range, and enough sustained request capacity for the desired backfill window. Do not use a provider that returns 401/403.
2. Allocate a durable independent analytics worker and PostgreSQL capacity. Apply migration 035, configure `EYELER_ANALYTICS_START_BLOCK=54773010`, and set `EYELER_ANALYTICS_RPC_URL` only through deployment configuration. Do not print its value.
3. Run and monitor the checkpoint from deployment through a fresh confirmed head. Compare selected historical ranges with another independent archival source where possible. Keep public history partial until the persisted flag becomes true after that replay.
4. Update the coverage fixture above in its owning branch, then rerun the full Node gate before integration.

This branch performs none of those production actions.
