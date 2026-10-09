# Analytics worker and API operations

Analytics v1 is public and read-only. `EYELER_ANALYTICS_ENABLED=true` mounts `/analytics/v1` on the HTTP server and permits the independent indexer script. Default is false. The indexer never signs, submits a transaction, or acquires the trading worker's lock.

## Sources

- Public, unsigned Perpl REST: `/v1/pub/context`, market candles and funding. Current market mark, OI, TVL, 24h volume and funding can work without an analytics database.
- Monad mainnet Exchange logs: official SDK event ABI, pinned SHA-256 `766fc81326bdf27f243ca582f65c3e2ff72bc639d88674876697a63ae1c47cb3`. The worker stores raw decoded logs, account mappings, flows, maker fills, taker fees, liquidations and position changes, then refreshes hourly/daily market rollups.
- Confirmation-depth on-chain view calls: `getAccountByAddr` and `getPositionV2` provide current wallet margin and open positions without a signed Perpl account key. The existing profile uses head minus 12; this is not consensus-finality proof. The internal historical-owner resolver separately requires an RPC `finalized` block, matching historical hash, address/ID roundtrip and repeated canonical hash checks.

## Configuration

| Variable                       | Purpose                                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EYELER_ANALYTICS_ENABLED`     | `true` to expose routes and run worker; otherwise off.                                                                                                               |
| `DATABASE_URL`                 | PostgreSQL connection for indexer and indexed API data. Run `npm run db:migrate` first.                                                                              |
| `EYELER_ANALYTICS_START_BLOCK` | Optional start block. If absent, the worker finds a block around seven days before the head. For full history, set `54773010`, the verified Exchange creation block. |
| `EYELER_ANALYTICS_RPC_URL`     | Optional read-only Monad RPC override for the worker and wallet-chain views. Without it, both use the repository's public Monad mainnet RPC; the worker starts with partial recent history. Full history requires complete historical logs and sufficient replay throughput. Never commit or log private RPC URLs. |
| `ANALYTICS_PERPL_API_URL`      | Public REST base; defaults to `https://app.perpl.xyz/api`.                                                                                                           |
| `ANALYTICS_CONFIRMATIONS`      | Confirmation depth, default 12 blocks, range 1–256; not a consensus-finalized tag.                                                                                   |
| `ANALYTICS_CHUNK_SIZE`         | Bounded log chunk, default 20 blocks, range 1–100.                                                                                                                   |
| `ANALYTICS_POLL_MS`            | Caught-up polling, default 3,000 ms.                                                                                                                                 |
| `ANALYTICS_CORS_ORIGIN`        | Optional exact HTTPS origin for future analytics frontend. `https://app.eyeler.xyz` is always allowed.                                                               |

Start worker separately with `npm run analytics:indexer`. A dedicated PostgreSQL advisory lock `(143, 20261007)` prevents duplicate analytics workers; no trading lock is used. The default log range is 20 blocks, capped at 100, to stay below public RPC response limits. Each step checks chain 143 before checkpoint mutation and rereads its boundary hash before saving. Checkpoint advances in the same transaction as raw and derived rows. Restarting with an earlier configured start block moves the checkpoint back; existing rows remain and idempotent inserts replay the overlap. A mismatch in the previous confirmed block hash rewinds 64 blocks (bounded by the stored start), cascades derived rows from raw events and rebuilds rollups. HTTP 401/403 errors stop the worker. Other transient failures use exponential backoff up to 60 seconds and 100 ms pacing between successful chunks.

The public RPC serves sampled logs at the verified creation block `54773010`, but limits `eth_getLogs` to 100-block ranges. It does not serve arbitrary old state through `eth_getCode`; historical state and historical logs are separate capabilities. A complete replay and sustained throughput remain unverified. See [verification](verification.md). Without `EYELER_ANALYTICS_START_BLOCK`, the automatic recent start is explicitly partial, whether the RPC is the public default or an override. Indexed responses expose `coverage.label` such as `Since 2026-10-01`. An earlier `EYELER_ANALYTICS_START_BLOCK` rewinds the next worker run safely. `completeHistory` remains false unless the pinned deployment start is stored and replay has reached a fresh confirmation-depth boundary. This coverage marker does not constitute consensus finality. Checkpoint write time alone never makes old history fresh.

## Public mobile dashboard

The Flutter application exposes `/analytics` without wallet authentication; its hash URL is `https://app.eyeler.xyz/#/analytics`. The signed-out screen also offers “Browse public analytics.” This route uses a separate GET-only transport scoped to `/analytics/v1/`, without access to session tokens or wallet storage. Private routes keep their existing authentication gates. The API flag must still be enabled by an operator before real analytics data can load. This implementation has not been deployed.

The dashboard labels its data “Monad mainnet” independently of the trading environment. Historical window labels come from server coverage metadata. Fixtures are restricted to tests; missing or disabled API data must produce the normal unavailable state, never substitute sample data.

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
