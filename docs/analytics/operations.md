# Analytics worker and API operations

Analytics v1 is public and read-only. `EYELER_ANALYTICS_ENABLED=true` mounts `/analytics/v1` on the HTTP server and permits the independent indexer script. Default is false. The indexer never signs, submits a transaction, or acquires the trading worker's lock.

## Sources

- Public, unsigned Perpl REST: `/v1/pub/context`, market candles and funding. Current market mark, OI, TVL, 24h volume and funding can work without an analytics database.
- Monad mainnet Exchange logs: official SDK event ABI, pinned SHA-256 `766fc81326bdf27f243ca582f65c3e2ff72bc639d88674876697a63ae1c47cb3`. The worker stores raw decoded logs, account mappings, flows, maker fills, taker fees, liquidations and position changes, then refreshes hourly/daily market rollups.
- Finalized on-chain view calls: `getAccountByAddr` and `getPositionV2` provide current wallet margin and open positions without a signed Perpl account key.

## Configuration

| Variable                       | Purpose                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EYELER_ANALYTICS_ENABLED`     | `true` to expose routes and run worker; otherwise off.                                                                                                                    |
| `DATABASE_URL`                 | PostgreSQL connection for indexer and indexed API data. Run `npm run db:migrate` first.                                                                                   |
| `EYELER_ANALYTICS_START_BLOCK` | Optional start block. If absent, the worker finds a block around seven days before the head. For full history, set `54773010`, the user-supplied Exchange creation block. |
| `EYELER_ANALYTICS_RPC_URL`     | Required read-only Monad RPC. Put it in `.env`; never commit or log its value. Full history requires an archive provider that serves logs from the creation block.        |
| `ANALYTICS_PERPL_API_URL`      | Public REST base; defaults to `https://app.perpl.xyz/api`.                                                                                                                |
| `ANALYTICS_CONFIRMATIONS`      | Finality depth, default 12 blocks, range 1–256.                                                                                                                           |
| `ANALYTICS_CHUNK_SIZE`         | Bounded log chunk, default 20 blocks, range 1–100.                                                                                                                        |
| `ANALYTICS_POLL_MS`            | Caught-up polling, default 3,000 ms.                                                                                                                                      |
| `ANALYTICS_CORS_ORIGIN`        | Optional exact HTTPS origin for future analytics frontend. `https://app.eyeler.xyz` is always allowed.                                                                    |

Start worker separately with `npm run analytics:indexer`. A dedicated PostgreSQL advisory lock `(143, 20261007)` prevents duplicate analytics workers; no trading lock is used. The default log range is 20 blocks, capped at 100, to stay below public RPC response limits. Checkpoint advances in the same transaction as raw and derived rows. Restarting with an earlier configured start block moves the checkpoint back; existing rows remain and idempotent inserts replay the overlap. A mismatch in the previous finalized block hash rewinds 64 blocks (bounded by the stored start), cascades derived rows from raw events and rebuilds rollups. HTTP 401/403 errors stop the worker. Other transient failures use exponential backoff up to 60 seconds and 100 ms pacing between successful chunks.

The public RPC rejected a full-range `eth_getLogs` request with HTTP 413 and did not serve old `eth_getCode` state (`RPC_-32602`). The user supplied creation transaction `0x22d1d74e137c3a82ac4b702fd90024811b184fcdcf8fd4d1473097b4d8a619f3` at block `54773010`; this has not yet been verified against an archive RPC. The automatic recent start is explicitly partial. Indexed responses expose `coverage.label` such as `Since 2026-10-01`. When an archive RPC and `EYELER_ANALYTICS_START_BLOCK=54773010` are added to `.env`, the next worker run resumes from that earlier block. `completeHistory` remains false until the archive backfill reaches the live finalized head.

## API behavior

Routes have a 60 requests/minute IP limit. Live snapshots cache 15 seconds; time series and funding cache 60 seconds. Wallet chain snapshots cache 15 seconds. Cursor pagination uses finalized `(block, transaction index, log index)` order. Query validation bounds ranges, market IDs, addresses, limits and compare size. `stale` flags incomplete backfill or lag; unavailable numbers are null, not zero. The historical trades route currently covers maker fills with an unambiguous position event in the same transaction. It remains `stale: true`; taker fills lack account and market IDs in the V2 event and need verified transaction correlation. Liquidation price, equity curve and drawdown remain unavailable until exact venue formulas or history are verified.

The p95 target is under 250 ms for cached/local responses. Run `npx tsx scripts/analytics-load.ts` for the offline cached `/markets` check. That check excludes Perpl and Monad network latency. Real first-hit and database p95 still need measurement after deployment and full backfill.

## Local verification

- `node --env-file-if-exists=.env --import tsx scripts/analytics-record-sample.ts` captures public recent mainnet logs as fixtures.
- `npx tsx scripts/analytics-record-public.ts` captures unsigned REST context, funding and candles.
- `node --env-file-if-exists=.env --import tsx scripts/analytics-record-wallet.ts` captures one finalized public wallet view.
- `node --env-file-if-exists=.env --import tsx scripts/analytics-backfill-recent.ts` indexes the first three chunks of the configured recent window into an in-memory PostgreSQL instance. It cannot modify production data.
- `node --env-file-if-exists=.env --import tsx scripts/analytics-verify-live.ts` compares public Perpl stats with candles and checks a live wallet view.
- `node --env-file-if-exists=.env --import tsx scripts/analytics-find-deployment.ts` checks initialization logs in a 20-block range from the configured start block.

See [verification](verification.md) and [metric definitions](metrics.md).
