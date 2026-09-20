import type { PostgresStore } from '../database/postgres-store.js'
import type { RuntimeVenue } from '../../runtime.js'
import { PerplAdapter, perplNetworks } from '../../../../packages/perpl/src/index.js'
import { PerplLiveAdapter, type ReconciliationContext } from '../../../../packages/perpl/src/live.js'
import { PerplHistory } from '../../../../packages/perpl/src/history.js'
import { Ed25519PerplSigner } from '../../../../packages/perpl/src/signer.js'
import { PerplTradingClient } from '../../../../packages/perpl/src/trading.js'
import { buildTelemetryFreshness, defaultFreshnessThresholds, type Action, type Book, type NormalizedTelemetry, type Position } from '../../../../packages/domain/src/index.js'
import { ChainAdapter } from '../../../../packages/chain/src/index.js'
import { AusdAdapter } from '../../../../packages/ausd/src/index.js'
import { AgoraAdapter } from '../../../../packages/chain/src/agora.js'
import { getAddress } from 'viem'
import { logger } from '../../config/index.js'

export function assertPerplBookSetupReady(position: Position, telemetry: NormalizedTelemetry, now = Date.now(), freshnessWindowMs = defaultFreshnessThresholds.marketMs) {
  const positionObservedAt = position.observedAt ?? position.timestamp
  const positionFreshnessMs = positionObservedAt === undefined ? Number.POSITIVE_INFINITY : now - positionObservedAt
  const sourceFresh = telemetry.freshness
    ? [telemetry.freshness.market, telemetry.freshness.position, telemetry.freshness.funding, telemetry.freshness.orderbook].every(point => point.status === 'FRESH')
    : Number.isFinite(telemetry.freshnessMs) && telemetry.freshnessMs >= 0 && telemetry.freshnessMs <= freshnessWindowMs && Number.isFinite(positionFreshnessMs) && positionFreshnessMs >= 0 && positionFreshnessMs <= freshnessWindowMs
  if (position.status !== 'OPEN' || !Number.isFinite(position.size) || position.size <= 0 || !Number.isFinite(position.entryPrice) || !Number.isFinite(position.margin) || position.margin < 0 || !sourceFresh) throw new Error('PERPL_TELEMETRY_STALE')
}

export function createPerplRuntime(store: PostgresStore): RuntimeVenue | undefined {
  const env = process.env
  if (!env.PERPL_API_KEY || !env.PERPL_API_KEY_SECRET || !env.PERPL_ACCOUNT_ID) return undefined
  const environment = env.KEEL_ENV === 'mainnet' ? 'mainnet' : 'testnet'
  const network = { ...perplNetworks[environment], ...(env.PERPL_REST_URL ? { restUrl: env.PERPL_REST_URL } : {}), ...(env.PERPL_WS_URL ? { wsUrl: env.PERPL_WS_URL } : {}), ...(env.PERPL_CHAIN_ID ? { chainId: Number(env.PERPL_CHAIN_ID) } : {}) }
  const signer = new Ed25519PerplSigner(env.PERPL_API_KEY, env.PERPL_API_KEY_SECRET, network.chainId)
  const adapter = new PerplAdapter(environment, signer, network)
  const trading = new PerplTradingClient(network, signer)
  const history = new PerplHistory(network.restUrl, signer)
  const chain = new ChainAdapter(environment, { rpcUrl: env.MONAD_RPC_URL ?? network.rpcUrl, chainId: Number(env.MONAD_CHAIN_ID ?? network.chainId), ausdToken: getAddress(env.AUSD_TOKEN_ADDRESS ?? network.collateralToken) })
  const ausd = new AusdAdapter(chain)
  const agora = new AgoraAdapter(env.AGORA_API_URL, env.AGORA_API_KEY)
  const freshnessThresholds = defaultFreshnessThresholds
  const telemetryForPosition = (telemetry: NormalizedTelemetry, position: Position, now = Date.now()): NormalizedTelemetry => {
    const positionUpdatedAt = position.observedAt ?? position.timestamp
    return { ...telemetry, positionTimestamp: positionUpdatedAt, positionFreshnessMs: positionUpdatedAt === undefined ? undefined : now - positionUpdatedAt, freshness: buildTelemetryFreshness({ marketUpdatedAt: telemetry.marketTimestamp, positionUpdatedAt, fundingUpdatedAt: telemetry.fundingTimestamp, orderbookUpdatedAt: telemetry.orderbookTimestamp }, now, freshnessThresholds) }
  }
  const contextFor = async (action: Action): Promise<ReconciliationContext> => {
    const row = (await store.pool.query('SELECT b.market_id,b.venue_account_id,b.venue_position_id,p.* FROM books b JOIN positions p ON p.book_id=b.id WHERE b.id=$1', [action.bookId])).rows[0]
    if (!row || !row.market_id || !row.venue_account_id || !row.venue_position_id) throw new Error('BOOK_VENUE_BINDING_REQUIRED')
    const market = await adapter.getMarket(Number(row.market_id)) as { instance_id?: number; order_ttl_blocks?: number; config?: { size_decimals?: number; price_decimals?: number } } | null
    const protocol = await adapter.getProtocolContext()
    const chain = protocol.chain as { gas?: { h?: number } } | undefined
    const token = protocol.tokens.find(item => item.id === protocol.instances.find(instance => instance.id === market?.instance_id)?.collateral_token_id)
    return { marketId: Number(row.market_id), accountId: Number(row.venue_account_id), positionId: Number(row.venue_position_id), position: { bookId: action.bookId, side: row.side as 'LONG' | 'SHORT', size: Number(row.size), entryPrice: Number(row.entry_price), markPrice: Number(row.mark_price), liquidationPrice: Number(row.liquidation_price), leverage: Number(row.leverage), unrealizedPnl: Number(row.unrealized_pnl), margin: Number(row.margin), status: row.status as Position['status'] }, headBlock: Number(chain?.gas?.h ?? 0), orderTtlBlocks: market?.order_ttl_blocks ?? 20, sizeDecimals: market?.config?.size_decimals ?? 0, priceDecimals: market?.config?.price_decimals ?? 0, leverageHundredths: Math.round(Number(row.leverage) * 100), collateralDecimals: token?.decimals ?? 6 }
  }
  const live = new PerplLiveAdapter(trading, contextFor, history, async action => { await store.pool.query('UPDATE actions SET venue_reference=$2 WHERE id=$1', [action.id, action.venueReference]) })
  return {
    accountId: Number(env.PERPL_ACCOUNT_ID),
    async validate() { try { const context = await adapter.getProtocolContext(); if (!context.markets.length) return 'INVALID'; await adapter.getBalance(Number(env.PERPL_ACCOUNT_ID)); return 'VALID' } catch { return 'UNAVAILABLE' } },
    async loadBookSetup(marketId, accountId, positionId) {
      if (accountId !== Number(env.PERPL_ACCOUNT_ID)) throw new Error('PERPL_ACCOUNT_MISMATCH')
      const market = await adapter.getMarket(marketId) as { symbol?: string } | null
      if (!market?.symbol) throw new Error('PERPL_MARKET_NOT_FOUND')
      const position = await adapter.getPosition(accountId, marketId, positionId)
      if (!position || position.status !== 'OPEN') throw new Error('PERPL_POSITION_NOT_FOUND')
      const telemetry = await adapter.getNormalizedMarket(marketId)
      if (!telemetry) throw new Error('PERPL_TELEMETRY_NOT_READY')
      const now = Date.now()
      const currentTelemetry = telemetryForPosition(telemetry, position, now)
      assertPerplBookSetupReady(position, currentTelemetry, now, freshnessThresholds.marketMs)
      const { bookId: _bookId, ...positionSeed } = position
      const { source: _source, freshnessMs: _freshnessMs, ...telemetrySeed } = currentTelemetry
      const balance = await adapter.getBalance(accountId)
      const reserveAvailable = Number(balance.available)
      if (!Number.isFinite(reserveAvailable) || reserveAvailable < 0) throw new Error('PERPL_BALANCE_INVALID')
      return { market: market.symbol, position: positionSeed, telemetry: { ...telemetrySeed, source: currentTelemetry.source, freshnessMs: currentTelemetry.freshnessMs }, reserveAvailable }
    },
    async listPositions() {
      const context = await adapter.getProtocolContext()
      const accountId = Number(env.PERPL_ACCOUNT_ID)
      const result: Array<{ marketId: number; market: string; accountId: number; positionId: number; position: import('../../../../packages/domain/src/index.js').BookPositionSeed; telemetry?: import('../../../../packages/domain/src/index.js').BookTelemetrySeed }> = []
      for (const market of context.markets) {
        const rows = await adapter.getPositions(accountId, market.id)
        for (const row of rows.filter(item => item.st === 1)) {
          const position = await adapter.getPosition(accountId, market.id, row.pid)
          if (!position) continue
          const telemetry = await adapter.getNormalizedMarket(market.id)
          const { bookId: _bookId, ...positionSeed } = position
          if (telemetry) { const currentTelemetry = telemetryForPosition(telemetry, position); const { source: _source, freshnessMs: _freshnessMs, ...telemetrySeed } = currentTelemetry; result.push({ marketId: market.id, market: market.symbol, accountId, positionId: row.pid, position: positionSeed, telemetry: { ...telemetrySeed, source: currentTelemetry.source, freshnessMs: currentTelemetry.freshnessMs } }) }
          else result.push({ marketId: market.id, market: market.symbol, accountId, positionId: row.pid, position: positionSeed })
        }
      }
      return result
    },
    async capital() {
      const accountId = Number(env.PERPL_ACCOUNT_ID)
      const perpl = await adapter.getBalance(accountId)
      const wallet = env.MONAD_WALLET_ADDRESS ? await ausd.walletBalance(getAddress(env.MONAD_WALLET_ADDRESS)) : undefined
      const agoraMetrics = env.AGORA_METRICS_ENABLED === 'true' ? await agora.metrics() : undefined
      return { status: 'VALID' as const, accountId, ausdBalance: wallet ? wallet.raw.toString() : null, perplAvailable: perpl.available, perplLocked: perpl.locked, bookReserved: null, bookDeployed: null, bookRemaining: null, unreservedCapital: null, ausd: wallet ? { raw: wallet.raw.toString(), decimals: wallet.decimals, symbol: wallet.symbol, token: wallet.token, chainId: wallet.chainId } : undefined, agora: agoraMetrics }
    },
    async start() {
      try { await trading.connect() }
      catch (error) { logger.warn({ error: error instanceof Error ? error.message : 'PERPL_WS_START_FAILED', lifecycle: trading.lifecycleState() }, 'Perpl read-only trading stream not ready; readiness remains fail-closed') }
    },
    ready() { return trading.isReady() },
    async close() { trading.close(); adapter.close() },
    async submit(action) { return live.submit(action) },
    async reconcile(action) { return live.reconcile(action) },
    async refresh(book: Book) {
      if (!book.marketId || !book.venueAccountId) throw new Error('BOOK_VENUE_BINDING_REQUIRED')
      const telemetry = await adapter.getNormalizedMarket(book.marketId)
      const position = await adapter.getPosition(book.venueAccountId, book.marketId, book.venuePositionId)
      if (!telemetry || !position) throw new Error('PERPL_STATE_UNAVAILABLE')
      await store.pool.query(`INSERT INTO positions(book_id,size,entry_price,mark_price,liquidation_price,leverage,unrealized_pnl,margin,status,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(book_id) DO UPDATE SET size=EXCLUDED.size,mark_price=EXCLUDED.mark_price,liquidation_price=EXCLUDED.liquidation_price,leverage=EXCLUDED.leverage,unrealized_pnl=EXCLUDED.unrealized_pnl,margin=EXCLUDED.margin,status=EXCLUDED.status,observed_at=now()`, [book.id, position.size, position.entryPrice, position.markPrice, position.liquidationPrice, position.leverage, position.unrealizedPnl, position.margin, position.status])
      await store.pool.query('INSERT INTO risk_snapshots(book_id,block,timestamp,mark,oracle,liquidation,funding,spread,depth,volatility,reserve,freshness,source,bid,ask,mid) SELECT $1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,$8,$9,$10,r.available,$11,$12,$13,$14,$15 FROM reserves r WHERE r.book_id=$1', [book.id, telemetry.block, telemetry.marketTimestamp ?? telemetry.timestamp, telemetry.mark, telemetry.oracle, position.liquidationPrice, telemetry.fundingRate, telemetry.spreadBps, telemetry.depthNotional, telemetry.volatility, telemetry.freshnessMs, telemetry.source, telemetry.bid, telemetry.ask, telemetry.mid])
    },
  }
}

