import type { PostgresStore } from '../database/postgres-store.js'
import type { RuntimeVenue } from '../../runtime.js'
import {
  PerplAdapter,
  perplNetworks,
  decodeAmount,
  decodePrice,
  decodeSize,
  normalizePerplPosition,
  type PerplBalance,
} from '../../../../packages/perpl/src/index.js'
import { PerplLiveAdapter, type ReconciliationContext } from '../../../../packages/perpl/src/live.js'
import { PerplHistory } from '../../../../packages/perpl/src/history.js'
import { Ed25519PerplSigner } from '../../../../packages/perpl/src/signer.js'
import { PerplTradingClient } from '../../../../packages/perpl/src/trading.js'
import type { WirePosition } from '../../../../packages/perpl/src/decoder.js'
import { PerplRequestIdAllocator } from './request-id-allocator.js'
import { listOpeningMarkets, openingMarketSnapshot } from '../../../../packages/perpl/src/opening-market.js'
import {
  buildTelemetryFreshness,
  defaultFreshnessThresholds,
  freshnessPoint,
  type Action,
  type Book,
  type BookCreationReadiness,
  type NormalizedTelemetry,
  type Position,
} from '../../../../packages/domain/src/index.js'
import { ChainAdapter, chainConfigs } from '../../../../packages/chain/src/index.js'
import { AusdAdapter } from '../../../../packages/ausd/src/index.js'
import { AgoraAdapter } from '../../../../packages/chain/src/agora.js'
import { readAgoraActivity } from '../agora/activity.js'
import { readCapital } from '../capital/snapshot.js'
import { decodeEventLog, getAddress, parseAbi, parseUnits } from 'viem'
import Decimal from 'decimal.js'
import { brandEnv, logger } from '../../config/index.js'

export function assertPerplFreeBalance(
  balance: PerplBalance,
  amount: number,
  now = Date.now(),
  freshnessMs = defaultFreshnessThresholds.marketMs,
) {
  if (!Number.isFinite(balance.updatedAt) || balance.updatedAt! > now || now - balance.updatedAt! > freshnessMs)
    throw new Error('PERPL_FREE_BALANCE_UNAVAILABLE')
  try {
    const free = new Decimal(balance.available).minus(balance.locked)
    const needed = new Decimal(amount)
    if (!free.isFinite() || !needed.isFinite() || needed.lte(0)) throw new Error('PERPL_FREE_BALANCE_UNAVAILABLE')
    if (free.lt(needed)) throw new Error('PERPL_FREE_BALANCE_INSUFFICIENT')
  } catch (error) {
    if (error instanceof Error && error.message === 'PERPL_FREE_BALANCE_INSUFFICIENT') throw error
    throw new Error('PERPL_FREE_BALANCE_UNAVAILABLE')
  }
}

export function perplBookCreationReadiness(
  position: Position,
  telemetry: NormalizedTelemetry,
  now = Date.now(),
  freshnessWindowMs = defaultFreshnessThresholds.marketMs,
): BookCreationReadiness {
  // Perpl history `at.t` is the venue event time (often the position's
  // opening/update event), not the time this authenticated snapshot was
  // observed. Freshness for a REST snapshot must use the adapter receipt
  // time when available; the venue timestamp remains available on Position.
  const positionObservedAt = position.observedAt ?? position.timestamp
  const market =
    telemetry.freshness?.market ??
    freshnessPoint(telemetry.marketTimestamp ?? telemetry.timestamp, now, freshnessWindowMs)
  const positionFreshness = telemetry.freshness?.position ?? freshnessPoint(positionObservedAt, now, freshnessWindowMs)
  const blocked = (code: BookCreationReadiness['code'], reason: string): BookCreationReadiness => ({
    allowed: false,
    code,
    reason,
    market,
    position: positionFreshness,
  })
  if (position.status !== 'OPEN') return blocked('POSITION_NOT_OPEN', 'Selected Perpl position is not open.')
  if (
    !Number.isFinite(position.size) ||
    position.size <= 0 ||
    !Number.isFinite(position.entryPrice) ||
    position.entryPrice <= 0 ||
    !Number.isFinite(position.margin) ||
    position.margin < 0
  )
    return blocked('POSITION_INVALID', 'Selected Perpl position values are invalid.')
  if (
    ![telemetry.mark, telemetry.oracle, telemetry.bid, telemetry.ask].every(Number.isFinite) ||
    telemetry.mark <= 0 ||
    telemetry.oracle <= 0 ||
    telemetry.bid <= 0 ||
    telemetry.ask < telemetry.bid
  )
    return blocked('MARKET_INVALID', 'Current Perpl market values are invalid.')
  if (market.status === 'UNKNOWN') return blocked('MARKET_TELEMETRY_UNKNOWN', 'Live market telemetry is unavailable.')
  if (market.status === 'STALE')
    return blocked(
      'MARKET_TELEMETRY_STALE',
      `Live market telemetry is stale${market.ageMs === undefined ? '.' : ` by ${market.ageMs}ms.`}`,
    )
  if (positionFreshness.status === 'UNKNOWN')
    return blocked('POSITION_TELEMETRY_UNKNOWN', 'Live position telemetry is unavailable.')
  if (positionFreshness.status === 'STALE')
    return blocked(
      'POSITION_TELEMETRY_STALE',
      `Live position telemetry is stale${positionFreshness.ageMs === undefined ? '.' : ` by ${positionFreshness.ageMs}ms.`}`,
    )
  return {
    allowed: true,
    code: 'READY',
    reason: 'Live market and position telemetry are within the configured safety threshold.',
    market,
    position: positionFreshness,
  }
}

export function assertPerplBookSetupReady(
  position: Position,
  telemetry: NormalizedTelemetry,
  now = Date.now(),
  freshnessWindowMs = defaultFreshnessThresholds.marketMs,
) {
  const readiness = perplBookCreationReadiness(position, telemetry, now, freshnessWindowMs)
  if (!readiness.allowed) throw Object.assign(new Error(readiness.code), { statusCode: 409, details: readiness })
}

export function verifiedCloseSnapshotValues(
  current: { position: WirePosition; observedAt?: number } | undefined,
  event: WirePosition,
  context: ReconciliationContext,
  expectedSizeRaw: bigint,
  freshCompleteSnapshot = false,
) {
  // History `c` is a signed event delta; the authenticated snapshot holds current collateral.
  if (
    event.acc !== context.accountId ||
    event.mkt !== context.marketId ||
    event.pid !== context.positionId ||
    event.sd !== (context.position.side === 'LONG' ? 1 : 2)
  )
    throw new Error('CLOSE_CURRENT_POSITION_UNVERIFIED')
  // Perpl omits closed positions from a fresh mt:26 snapshot after reconnect.
  if (!current && freshCompleteSnapshot && event.st === 2 && expectedSizeRaw === 0n)
    return { size: 0, entry: 0, margin: '0', status: 'CLOSED' as const }
  const position = current?.position
  if (
    !position ||
    position.acc !== context.accountId ||
    position.mkt !== context.marketId ||
    position.pid !== context.positionId ||
    !Number.isSafeInteger(position.s) ||
    BigInt(position.s) !== expectedSizeRaw ||
    position.st !== event.st ||
    position.sd !== event.sd ||
    !current.observedAt ||
    current.observedAt < (event.at.t ?? 0)
  )
    throw new Error('CLOSE_CURRENT_POSITION_UNVERIFIED')
  const status = position.st === 1 ? 'OPEN' : position.st === 2 ? 'CLOSED' : 'UNKNOWN'
  if (status === 'UNKNOWN') throw new Error('CLOSE_POSITION_STATUS_UNVERIFIABLE')
  return {
    size: decodeSize(position.s, context.sizeDecimals),
    entry: decodePrice(position.ep, context.priceDecimals),
    margin: decodeAmount(position.c, context.collateralDecimals),
    status,
  }
}

export function createPerplRuntime(
  store: PostgresStore,
  env: Record<string, string | undefined> = process.env,
): RuntimeVenue | undefined {
  if (!env.PERPL_API_KEY || !env.PERPL_API_KEY_SECRET || !env.PERPL_ACCOUNT_ID) return undefined
  const environment = brandEnv(env, 'ENV') === 'mainnet' ? 'mainnet' : 'testnet'
  const network = {
    ...perplNetworks[environment],
    ...(env.PERPL_REST_URL ? { restUrl: env.PERPL_REST_URL } : {}),
    ...(env.PERPL_WS_URL ? { wsUrl: env.PERPL_WS_URL } : {}),
    ...(env.PERPL_CHAIN_ID ? { chainId: Number(env.PERPL_CHAIN_ID) } : {}),
  }
  const signer = new Ed25519PerplSigner(env.PERPL_API_KEY, env.PERPL_API_KEY_SECRET, network.chainId)
  const adapter = new PerplAdapter(environment, signer, network)
  const requestIds = new PerplRequestIdAllocator(store.pool)
  const trading = new PerplTradingClient(
    network,
    signer,
    (line) => console.info(line),
    (accountId, lfr, _actionId, rejectedRq) => requestIds.allocate(accountId, lfr, rejectedRq),
  )
  const history = new PerplHistory(network.restUrl, signer, fetch, network.rpcUrl, network.exchangeAddress)
  const chain = new ChainAdapter(environment, {
    rpcUrl: env.MONAD_RPC_URL ?? network.rpcUrl,
    chainId: Number(env.MONAD_CHAIN_ID ?? network.chainId),
    ausdToken: getAddress(
      environment === 'testnet' ? network.collateralToken : (env.AUSD_TOKEN_ADDRESS ?? network.collateralToken),
    ),
  })
  const ausd = new AusdAdapter(chain)
  // Agora AUSD is separate from Perpl's USD collateral on testnet.
  const agoraChain = new ChainAdapter(environment, {
    rpcUrl: env.MONAD_RPC_URL ?? network.rpcUrl,
    chainId: Number(env.MONAD_CHAIN_ID ?? network.chainId),
    ausdToken: getAddress(
      environment === 'mainnet'
        ? (env.AUSD_TOKEN_ADDRESS ?? chainConfigs.mainnet.ausdToken)
        : chainConfigs.testnet.ausdToken,
    ),
  })
  const agoraAusd = new AusdAdapter(agoraChain)
  const agora = new AgoraAdapter(env.AGORA_API_URL, env.AGORA_API_KEY, (requestId, path, status) =>
    logger.info({ requestId, path, status }, 'Agora API response'),
  )
  const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])
  const collateralAbi = parseAbi([
    'event IncreasePositionCollateral(uint256 perpId,uint256 accountId,uint256 positionDepositCNS,uint256 amountCNS,uint256 balanceCNS)',
  ])
  const agoraEvidence = async (transactionHash: string, amount: string, wallet: string) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) return 'NONE' as const
    const receipt = await chain.client.getTransactionReceipt({ hash: transactionHash as `0x${string}` })
    if (receipt.status !== 'success') return 'NONE' as const
    const expected = parseUnits(amount, 6)
    let walletTransfer = false
    let perplCollateral = false
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === chain.config.ausdToken.toLowerCase()) {
        try {
          const event = decodeEventLog({ abi: transferAbi, topics: log.topics, data: log.data })
          if (
            event.eventName === 'Transfer' &&
            event.args.value === expected &&
            (event.args.from.toLowerCase() === wallet.toLowerCase() ||
              event.args.to.toLowerCase() === wallet.toLowerCase())
          )
            walletTransfer = true
        } catch {
          /* Other token event. */
        }
      }
      if (
        chain.config.ausdToken.toLowerCase() === network.collateralToken.toLowerCase() &&
        log.address.toLowerCase() === network.exchangeAddress.toLowerCase()
      ) {
        try {
          const event = decodeEventLog({ abi: collateralAbi, topics: log.topics, data: log.data })
          if (
            event.eventName === 'IncreasePositionCollateral' &&
            event.args.accountId === BigInt(env.PERPL_ACCOUNT_ID!) &&
            event.args.amountCNS === expected
          )
            perplCollateral = true
        } catch {
          /* Other Exchange event. */
        }
      }
    }
    return walletTransfer
      ? perplCollateral
        ? ('WALLET_AND_PERPL' as const)
        : ('WALLET_TRANSFER' as const)
      : ('NONE' as const)
  }
  const freshnessThresholds = defaultFreshnessThresholds
  const telemetryForPosition = (
    telemetry: NormalizedTelemetry,
    position: Position,
    now = Date.now(),
  ): NormalizedTelemetry => {
    const positionUpdatedAt = position.observedAt ?? position.timestamp
    const freshness = buildTelemetryFreshness(
      {
        marketUpdatedAt: telemetry.marketTimestamp,
        positionUpdatedAt,
        fundingUpdatedAt: telemetry.fundingTimestamp,
        orderbookUpdatedAt: telemetry.orderbookTimestamp,
      },
      now,
      freshnessThresholds,
    )
    if (telemetry.freshness?.funding.effectiveAt !== undefined)
      freshness.funding.effectiveAt = telemetry.freshness.funding.effectiveAt
    return {
      ...telemetry,
      positionTimestamp: positionUpdatedAt,
      positionFreshnessMs: positionUpdatedAt === undefined ? undefined : now - positionUpdatedAt,
      freshness,
    }
  }
  /** mt:26/27 is the current position state. Signed position-history is an event log, not a current-state fallback. */
  const currentPosition = async (
    accountId: number,
    marketId: number,
    positionId?: number,
  ): Promise<Position | null> => {
    const stream = trading.isReady() ? trading.positionSnapshot(accountId, marketId, positionId) : undefined
    if (!stream) return null
    const protocol = await adapter.getProtocolContext()
    const market = protocol.markets.find((item) => item.id === marketId)
    if (!market) throw new Error('PERPL_MARKET_NOT_FOUND')
    const instance = protocol.instances.find((item) => item.id === market.instance_id)
    const token = protocol.tokens.find((item) => item.id === instance?.collateral_token_id)
    return normalizePerplPosition(stream.position, market, token?.decimals ?? 6, stream.observedAt ?? Date.now())
  }
  const syncClosedBook = async (book: Book): Promise<boolean> => {
    if (
      book.status === 'CLOSED' ||
      !book.marketId ||
      !book.venueAccountId ||
      !book.venuePositionId ||
      book.venueAccountId !== Number(env.PERPL_ACCOUNT_ID) ||
      !trading.isReady()
    )
      return false
    const signed = trading.stateSnapshot()
    if (!signed.accounts.some((account) => account.id === book.venueAccountId)) return false
    const position = signed.positions.find(
      (item) => item.acc === book.venueAccountId && item.mkt === book.marketId && item.pid === book.venuePositionId,
    )
    if (position && position.st !== 2 && position.s !== 0) return false
    // A complete, heartbeat-current mt:26 snapshot omits externally closed positions.
    // Never close a Book while an action still needs venue reconciliation.
    const client = await store.pool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query('SELECT status FROM books WHERE id=$1 FOR UPDATE', [book.id])
      if (!locked.rows.length || locked.rows[0].status === 'CLOSED') {
        await client.query('COMMIT')
        return false
      }
      const pending = await client.query(
        "SELECT 1 FROM actions WHERE book_id=$1 AND status IN ('QUEUED','VALIDATING','SUBMITTING','SUBMITTED','VERIFYING','UNKNOWN','PARTIAL') LIMIT 1",
        [book.id],
      )
      if (pending.rows.length) {
        await client.query('COMMIT')
        return false
      }
      const updated = await client.query(
        "UPDATE positions SET size=0,status='CLOSED',unrealized_pnl=0,observed_at=now() WHERE book_id=$1 RETURNING book_id",
        [book.id],
      )
      if (!updated.rows.length) {
        await client.query('COMMIT')
        return false
      }
      await client.query(
        "UPDATE books SET status='CLOSED',automation_enabled=false,safety_action_id=NULL,updated_at=now() WHERE id=$1",
        [book.id],
      )
      await client.query('COMMIT')
      logger.info(
        { bookId: book.id, accountId: book.venueAccountId, positionId: book.venuePositionId },
        'Book closed after authoritative Perpl position snapshot',
      )
      return true
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
  const contextFor = async (action: Action): Promise<ReconciliationContext> => {
    const row = (
      await store.pool.query(
        'SELECT b.market_id,b.venue_account_id,b.venue_position_id,b.side AS book_side,p.* FROM books b JOIN positions p ON p.book_id=b.id WHERE b.id=$1',
        [action.bookId],
      )
    ).rows[0]
    if (
      !row ||
      !row.market_id ||
      !row.venue_account_id ||
      !row.venue_position_id ||
      !['LONG', 'SHORT'].includes(row.book_side)
    )
      throw new Error('BOOK_VENUE_BINDING_REQUIRED')
    const market = (await adapter.getMarket(Number(row.market_id))) as {
      instance_id?: number
      order_ttl_blocks?: number
      config?: { size_decimals?: number; price_decimals?: number }
    } | null
    const protocol = await adapter.getProtocolContext()
    const token = protocol.tokens.find(
      (item) =>
        item.id === protocol.instances.find((instance) => instance.id === market?.instance_id)?.collateral_token_id,
    )
    return {
      marketId: Number(row.market_id),
      accountId: Number(row.venue_account_id),
      positionId: Number(row.venue_position_id),
      position: {
        bookId: action.bookId,
        side: row.book_side as 'LONG' | 'SHORT',
        size: Number(row.size),
        entryPrice: Number(row.entry_price),
        markPrice: Number(row.mark_price),
        liquidationPrice: Number(row.liquidation_price),
        leverage: Number(row.leverage),
        unrealizedPnl: Number(row.unrealized_pnl),
        margin: Number(row.margin),
        status: row.status as Position['status'],
      },
      headBlock: trading.heartbeat()?.head ?? 0,
      orderTtlBlocks: market?.order_ttl_blocks ?? 0,
      sizeDecimals: market?.config?.size_decimals ?? 0,
      priceDecimals: market?.config?.price_decimals ?? 0,
      leverageHundredths: Math.round(Number(row.leverage) * 100),
      collateralDecimals: token?.decimals ?? 6,
    }
  }
  const verificationTimeoutMs = Number(env.EYELER_ORDER_VERIFY_TIMEOUT_MS ?? 180_000)
  if (!Number.isSafeInteger(verificationTimeoutMs) || verificationTimeoutMs < 15_000)
    throw new Error('INVALID_EYELER_ORDER_VERIFY_TIMEOUT_MS')
  const live = new PerplLiveAdapter(
    trading,
    contextFor,
    history,
    async (action) => {
      await store.pool.query('UPDATE actions SET venue_reference=$2 WHERE id=$1', [action.id, action.venueReference])
    },
    async (action, _evidence, verifiedPosition, context, expectedSizeRaw) => {
      if (
        !verifiedPosition ||
        !context ||
        expectedSizeRaw === undefined ||
        (action.kind !== 'REDUCE' && action.kind !== 'EXIT')
      )
        return
      const current = trading.positionSnapshot(context.accountId, context.marketId, context.positionId)
      const freshCompleteSnapshot = !current && action.kind === 'EXIT' && trading.isReady()
      const { size, entry, margin, status } = verifiedCloseSnapshotValues(
        current,
        verifiedPosition,
        context,
        expectedSizeRaw,
        freshCompleteSnapshot,
      )
      await store.pool.query(
        `UPDATE positions SET size=$2,entry_price=$3,leverage=$4,margin=$5,status=$6,unrealized_pnl=(mark_price-$3)*$2*CASE WHEN $7='LONG' THEN 1 ELSE -1 END,observed_at=now() WHERE book_id=$1`,
        [action.bookId, size, entry, verifiedPosition.lv / 100, margin, status, context.position.side],
      )
    },
    async (action) => {
      if (!action.venueReference) return false
      const result = await store.pool.query(
        `SELECT 1 FROM actions WHERE id<>$1
        AND split_part(venue_reference, ':', 1)=split_part($2, ':', 1)
        AND split_part(venue_reference, ':', 2)=split_part($2, ':', 2) LIMIT 1`,
        [action.id, action.venueReference],
      )
      return result.rows.length > 0
    },
    async (action, order) => {
      if (action.kind === 'DEFEND') {
        let balance: PerplBalance
        try {
          balance = await adapter.getBalance(order.acc)
        } catch {
          throw new Error('PERPL_FREE_BALANCE_UNAVAILABLE')
        }
        assertPerplFreeBalance(balance, action.amount)
        return
      }
      if (action.kind !== 'REDUCE' && action.kind !== 'EXIT') return
      const before = action.beforeState?.position
      if (!before || !order.lp) throw new Error('CLOSE_BASELINE_UNAVAILABLE')
      const position = await currentPosition(order.acc, order.mkt, order.lp)
      const market = await adapter.getNormalizedMarket(order.mkt)
      if (!position || !market) throw new Error('CLOSE_LIVE_TELEMETRY_UNAVAILABLE')
      const readiness = perplBookCreationReadiness(
        position,
        telemetryForPosition(market, position),
        Date.now(),
        freshnessThresholds.marketMs,
      )
      if (!readiness.allowed) throw new Error(readiness.code)
      if (position.side !== before.side || !new Decimal(position.size).eq(before.size))
        throw new Error('CLOSE_POSITION_CHANGED_BEFORE_SEND')
      if (order.t !== (position.side === 'LONG' ? 3 : 4)) throw new Error('CLOSE_DIRECTION_MISMATCH_BEFORE_SEND')
    },
    verificationTimeoutMs,
  )
  return {
    accountId: Number(env.PERPL_ACCOUNT_ID),
    async listOpeningMarkets() {
      if (!trading.isReady()) throw new Error('PERPL_TRADING_STATE_UNTRUSTED')
      return listOpeningMarkets(await adapter.getProtocolContext())
    },
    async openingMarketSnapshot(marketId) {
      if (!trading.isReady()) throw new Error('PERPL_TRADING_STATE_UNTRUSTED')
      const accountId = Number(env.PERPL_ACCOUNT_ID)
      const account = trading.stateSnapshot().accounts.find((item) => item.id === accountId)
      const heartbeat = trading.heartbeat()
      const observedAt = trading.heartbeatObservedAt()
      if (!account || !heartbeat || !observedAt || !account.fw || account.fr)
        throw new Error('PERPL_ACCOUNT_STATE_UNAVAILABLE')
      const [protocol, balance] = await Promise.all([adapter.getProtocolContext(), adapter.getBalance(accountId)])
      return openingMarketSnapshot(
        protocol,
        marketId,
        accountId,
        environment,
        balance,
        { head: heartbeat.head, observedAt },
        account.ft,
      )
    },
    async validate() {
      try {
        const context = await adapter.getProtocolContext()
        if (!context.markets.length) return 'INVALID'
        await adapter.getBalance(Number(env.PERPL_ACCOUNT_ID))
        return 'VALID'
      } catch {
        return 'UNAVAILABLE'
      }
    },
    async loadBookSetup(marketId, accountId, positionId) {
      if (accountId !== Number(env.PERPL_ACCOUNT_ID)) throw new Error('PERPL_ACCOUNT_MISMATCH')
      const market = (await adapter.getMarket(marketId)) as { symbol?: string } | null
      if (!market?.symbol) throw new Error('PERPL_MARKET_NOT_FOUND')
      const position = await currentPosition(accountId, marketId, positionId)
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
      return {
        market: market.symbol,
        position: positionSeed,
        telemetry: { ...telemetrySeed, source: currentTelemetry.source, freshnessMs: currentTelemetry.freshnessMs },
        reserveAvailable,
      }
    },
    async listPositions() {
      const context = await adapter.getProtocolContext()
      const accountId = Number(env.PERPL_ACCOUNT_ID)
      const result: Array<{
        marketId: number
        market: string
        accountId: number
        positionId: number
        position: import('../../../../packages/domain/src/index.js').BookPositionSeed
        telemetry?: import('../../../../packages/domain/src/index.js').BookTelemetrySeed
        bookCreation: BookCreationReadiness
      }> = []
      for (const market of context.markets) {
        const rows = trading.isReady()
          ? trading.stateSnapshot().positions.filter((item) => item.acc === accountId && item.mkt === market.id)
          : []
        for (const row of rows.filter((item) => item.st === 1)) {
          const position = await currentPosition(accountId, market.id, row.pid)
          if (!position) continue
          const telemetry = await adapter.getNormalizedMarket(market.id)
          const { bookId: _bookId, ...positionSeed } = position
          if (telemetry) {
            const currentTelemetry = telemetryForPosition(telemetry, position)
            const { source: _source, freshnessMs: _freshnessMs, ...telemetrySeed } = currentTelemetry
            result.push({
              marketId: market.id,
              market: market.symbol,
              accountId,
              positionId: row.pid,
              position: positionSeed,
              telemetry: {
                ...telemetrySeed,
                source: currentTelemetry.source,
                freshnessMs: currentTelemetry.freshnessMs,
              },
              bookCreation: perplBookCreationReadiness(position, currentTelemetry),
            })
          } else {
            const unavailableTelemetry = {
              mark: Number.NaN,
              oracle: Number.NaN,
              bid: Number.NaN,
              ask: Number.NaN,
              mid: Number.NaN,
              spreadBps: Number.NaN,
              fundingRate: Number.NaN,
              depthNotional: Number.NaN,
              volatility: Number.NaN,
              volume24h: Number.NaN,
              openInterest: Number.NaN,
              block: 0,
              timestamp: 0,
              source: 'perpl-rest' as const,
              freshnessMs: Number.POSITIVE_INFINITY,
            }
            result.push({
              marketId: market.id,
              market: market.symbol,
              accountId,
              positionId: row.pid,
              position: positionSeed,
              bookCreation: perplBookCreationReadiness(position, unavailableTelemetry),
            })
          }
        }
      }
      return result
    },
    capital: (walletAddress, userId) =>
      readCapital(
        {
          environment,
          store,
          accountId: Number(env.PERPL_ACCOUNT_ID),
          connectionId: env.EYELER_PERPL_CONNECTION_ID,
          readPerplBalance: () => adapter.getBalance(Number(env.PERPL_ACCOUNT_ID)),
          ausd,
          agoraAusd,
          agora,
          metricsEnabled: env.AGORA_METRICS_ENABLED === 'true',
          freshnessThresholds,
        },
        walletAddress,
        userId,
      ),
    async agoraActivity(walletAddress?: string, cursor?: string) {
      if (!env.AGORA_API_KEY) return { status: 'UNAVAILABLE' as const, reason: 'AGORA_NOT_CONNECTED', rows: [] }
      return readAgoraActivity(agora, walletAddress, agoraEvidence, cursor)
    },
    async start() {
      try {
        await trading.connect()
      } catch (error) {
        logger.warn(
          {
            error: error instanceof Error ? error.message : 'PERPL_WS_START_FAILED',
            lifecycle: trading.lifecycleState(),
          },
          'Perpl read-only trading stream not ready; readiness remains fail-closed',
        )
      }
    },
    ready() {
      return trading.isReady()
    },
    async syncClosedBooks(books: Book[]) {
      for (const book of books) await syncClosedBook(book)
    },
    async close() {
      trading.close()
      adapter.close()
    },
    async submit(action) {
      return live.submit(action)
    },
    async reconcile(action) {
      return live.reconcile(action)
    },
    async refresh(book: Book) {
      if (book.status === 'CLOSED') return
      if (!book.marketId || !book.venueAccountId) throw new Error('BOOK_VENUE_BINDING_REQUIRED')
      if (book.venueAccountId !== Number(env.PERPL_ACCOUNT_ID)) throw new Error('PERPL_ACCOUNT_MISMATCH')
      if (await syncClosedBook(book)) return
      const marketTelemetry = await adapter.getNormalizedMarket(book.marketId)
      const position = await currentPosition(book.venueAccountId, book.marketId, book.venuePositionId)
      if (!marketTelemetry || !position) throw new Error('PERPL_STATE_UNAVAILABLE')
      const telemetry = telemetryForPosition(marketTelemetry, position)
      // Use one market observation for both the position valuation and risk input.
      const pnl = new Decimal(telemetry.mark)
        .minus(position.entryPrice)
        .mul(position.size)
        .mul(position.side === 'LONG' ? 1 : -1)
        .toNumber()
      const client = await store.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('SELECT id FROM books WHERE id=$1 FOR UPDATE', [book.id])
        await client.query(
          `INSERT INTO positions(book_id,size,entry_price,mark_price,liquidation_price,leverage,unrealized_pnl,margin,status,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10/1000.0)) ON CONFLICT(book_id) DO UPDATE SET size=EXCLUDED.size,entry_price=EXCLUDED.entry_price,mark_price=EXCLUDED.mark_price,liquidation_price=EXCLUDED.liquidation_price,leverage=EXCLUDED.leverage,unrealized_pnl=EXCLUDED.unrealized_pnl,margin=EXCLUDED.margin,status=EXCLUDED.status,observed_at=EXCLUDED.observed_at`,
          [
            book.id,
            position.size,
            position.entryPrice,
            telemetry.mark,
            position.liquidationPrice,
            position.leverage,
            pnl,
            position.margin,
            position.status,
            position.observedAt ?? position.timestamp ?? Date.now(),
          ],
        )
        await client.query(
          'INSERT INTO risk_snapshots(book_id,block,timestamp,mark,oracle,liquidation,funding,spread,depth,volatility,reserve,freshness,source,bid,ask,mid,freshness_detail) SELECT $1,$2,to_timestamp($3/1000.0),$4,$5,$6,$7,$8,$9,$10,r.available,$11,$12,$13,$14,$15,$16 FROM reserves r WHERE r.book_id=$1',
          [
            book.id,
            telemetry.block,
            telemetry.marketTimestamp ?? telemetry.timestamp,
            telemetry.mark,
            telemetry.oracle,
            position.liquidationPrice,
            telemetry.fundingRate,
            telemetry.spreadBps,
            telemetry.depthNotional,
            telemetry.volatility,
            telemetry.freshnessMs,
            telemetry.source,
            telemetry.bid,
            telemetry.ask,
            telemetry.mid,
            JSON.stringify(telemetry.freshness),
          ],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}
