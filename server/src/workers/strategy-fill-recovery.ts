import type { Pool } from 'pg'
import type { RuntimeVenue } from '../runtime.js'
import { StrategyFillLedger } from '../infrastructure/strategies/fill-ledger.js'
import { StrategyLifecycleReader } from '../../../packages/perpl/src/strategy-lifecycle-reader.js'
import { perplNetworks } from '../../../packages/perpl/src/index.js'
import { strategyReceiptHash } from '../../../packages/perpl/src/strategy-identity.js'

/** Read-only financial recovery. This never sends orders or converts API fills into proof. */
export class StrategyFillRecovery {
  private cursor: { createdAt: Date; id: string } | null = null
  private readonly ledger: StrategyFillLedger
  constructor(
    private readonly pool: Pool,
    private readonly venues: RuntimeVenue | undefined,
    private readonly environment: 'mainnet' | 'testnet',
    rpcUrl: string,
  ) {
    const network = perplNetworks[environment]
    this.ledger = new StrategyFillLedger(
      pool,
      environment,
      network.exchangeAddress,
      new StrategyLifecycleReader(rpcUrl, network.chainId),
    )
  }
  async tick() {
    const rows = (
      await this.pool.query<{
        id: string
        user_id: string
        connection_id: string
        market_id: number
        venue_order_id: string
        created_at: Date
        placement_block: number
      }>(
        `SELECT o.id,s.user_id,s.connection_id,o.market_id,o.venue_order_id::text,o.created_at,
          (o.venue_progress->'strategyAdmission'->>'block')::int AS placement_block
        FROM strategy_orders o JOIN strategies s ON s.id=o.strategy_id
        WHERE o.environment=$1 AND o.simulated=false AND o.kind='POST' AND o.venue_order_id IS NOT NULL
          AND o.venue_progress ? 'strategyAdmission' AND s.mode='LIVE'
          AND ($2::timestamptz IS NULL OR (o.created_at,o.id)>($2::timestamptz,$3::uuid))
        ORDER BY o.created_at,o.id LIMIT 4`,
        [this.environment, this.cursor?.createdAt ?? null, this.cursor?.id ?? null],
      )
    ).rows
    for (const row of rows) {
      this.cursor = { createdAt: row.created_at, id: row.id }
      try {
        if (!Number.isSafeInteger(row.placement_block) || row.placement_block <= 0) continue
        const venue = await this.venues?.forUser?.(row.user_id, row.connection_id)
        if (!venue?.strategyFillCandidates) continue
        const candidates = await venue.strategyFillCandidates(row.market_id, row.placement_block)
        const credited = (
          await this.pool.query<{
            transaction_hash: string
            fill: {
              transactionLogIndex: number
              sizeRaw: string
              priceRaw: string
              grossFeeRaw: string
              builderFeeRaw: string
            }
          }>(
            "SELECT transaction_hash,evidence->'fill' AS fill FROM strategy_verified_fills WHERE order_id=$1 AND environment=$2",
            [row.id, this.environment],
          )
        ).rows
        const owned = candidates
          .filter((fill) => String(fill.oid) === row.venue_order_id && fill.l === 1)
          .filter(
            (candidate) =>
              !credited.some(
                (prior) =>
                  prior.transaction_hash === strategyReceiptHash(candidate.at.txid) &&
                  prior.fill.transactionLogIndex === candidate.at.l &&
                  prior.fill.sizeRaw === String(candidate.s) &&
                  prior.fill.priceRaw === String(candidate.p) &&
                  prior.fill.grossFeeRaw === candidate.f &&
                  prior.fill.builderFeeRaw === (candidate.bfa ?? '0'),
              ),
          )
          .sort(
            (a, b) => (a.at.b ?? 0) - (b.at.b ?? 0) || (a.at.tx ?? 0) - (b.at.tx ?? 0) || (a.at.l ?? 0) - (b.at.l ?? 0),
          )
        // A bounded pass resumes durable lifecycle checkpoints on the next pass.
        for (const candidate of owned.slice(0, 8)) await this.ledger.ingest(row.user_id, row.id, candidate)
      } catch {
        /* Incomplete or unsupported proof keeps the intent and capital unresolved. */
      }
    }
    if (rows.length < 4) this.cursor = null
  }
}
