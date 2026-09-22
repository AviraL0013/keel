import { createHttp, type VenueHttp } from '../../shared/src/http.js'
import type { Action, NormalizedTelemetry, Position } from '../../domain/src/index.js'
import WS from 'ws'
import Decimal from 'decimal.js'
import { normalizeMarketStream } from './marketDecoder.js'
import { PerplHistory } from './history.js'
import type { WirePosition, WireOrder, WireFill } from './decoder.js'
import { decodeAmount, decodePrice, decodeSize, decodeTimestamp } from './units.js'
import { PerplMarketStream } from './marketStream.js'
import { normalizeContextFunding } from './funding.js'
export { decodePrice, decodeSize, encodePrice, encodeSize, decodeAmount, encodeAmount, decodeTimestamp } from './units.js'
export { PerplHistory } from './history.js'
export type PerplEnvironment = 'testnet' | 'mainnet'
export type PerplConfig = { environment: PerplEnvironment; restUrl: string; wsUrl: string; chainId: number; rpcUrl: string; exchangeAddress: string; collateralToken: string }
export const perplNetworks: Record<PerplEnvironment, PerplConfig> = {
  mainnet: { environment: 'mainnet', restUrl: 'https://app.perpl.xyz/api', wsUrl: 'wss://app.perpl.xyz', chainId: 143, rpcUrl: 'https://rpc.monad.xyz', exchangeAddress: '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F', collateralToken: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' },
  testnet: { environment: 'testnet', restUrl: 'https://testnet.perpl.xyz/api', wsUrl: 'wss://testnet.perpl.xyz', chainId: 10143, rpcUrl: 'https://testnet-rpc.monad.xyz', exchangeAddress: '0x1964c32f0be608e7d29302aff5e61268e72080cc', collateralToken: '0xdf5b718d8fcc173335185a2a1513ee8151e3c027' },
}
export type PerplContext = { chain: unknown; instances: Array<{ id: number; collateral_token_id: number }>; tokens: Array<{ id?: number; decimals: number }>; markets: Array<{ id: number; symbol: string; instance_id?: number; funding_interval_blocks?: number; config: Record<string, unknown>; state: Record<string, unknown>; funding: Record<string, unknown> }> }
export type PerplBalance = { available: string; locked: string; decimals: number; updatedAt?: number }
export type VenueAdapter = { getProtocolContext(): Promise<PerplContext>; getMarket(marketId: number): Promise<unknown>; getMarketState(marketId: number): Promise<unknown>; getOrderBook(marketId: number): Promise<unknown>; getFunding(marketId: number): Promise<unknown>; getPosition(accountId: number, marketId: number, positionId?: number): Promise<Position | null>; getBalance(accountId: number): Promise<PerplBalance>; submit(action: Action): Promise<{ venueReference: string; status: 'SUBMITTED' | 'CONFIRMED' | 'PARTIAL' | 'CANCELED' | 'EXPIRED' | 'UNKNOWN' | 'FAILED' }>; reconcile(action: Action): Promise<Action>; connect(streams: string[], onMessage: (message: unknown) => void): Promise<() => void> }

/** Convert Perpl collateral base units at the venue boundary. Keep fixed precision in the API value. */
export function normalizePerplBalance(rawAvailable: string, rawLocked: string, decimals: number, updatedAt?: number): PerplBalance {
  if (!/^\d+(?:\.\d+)?$/.test(rawAvailable) || !/^\d+(?:\.\d+)?$/.test(rawLocked) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('PERPL_BALANCE_INVALID')
  const scale = new Decimal(10).pow(decimals)
  return { available: new Decimal(rawAvailable).div(scale).toFixed(decimals), locked: new Decimal(rawLocked).div(scale).toFixed(decimals), decimals, updatedAt }
}
export type ApiKeySigner = { apiKey: string; sign(method: string, path: string, body: string, timestamp: string, nonce: string): Promise<string> }
export function mapPerplPositionStatus(status: number): Position['status'] {
  if (status === 1) return 'OPEN'
  if (status === 2) return 'CLOSED'
  if (status === 3) return 'LIQUIDATED'
  if (status === 4) return 'DELEVERAGED'
  if (status === 5) return 'UNWOUND'
  if (status === 6) return 'FAILED'
  return 'FAILED'
}
type PerplMarketForPosition = { instance_id?: number; config: Record<string, unknown>; state: Record<string, unknown> }
/** Normalize a Position wire row once, using venue decimals from context. */
export function normalizePerplPosition(row: WirePosition, market: PerplMarketForPosition, collateralDecimals: number, observedAt = Date.now()): Position {
  const priceDecimals = Number(market.config.price_decimals)
  const sizeDecimals = Number(market.config.size_decimals)
  const entryPrice = decodePrice(row.ep, priceDecimals)
  const markPrice = decodePrice(Number(market.state.mrk), priceDecimals)
  const size = decodeSize(row.s, sizeDecimals)
  const marginText = decodeAmount(row.c, collateralDecimals)
  const margin = new Decimal(marginText).toNumber()
  const maintenanceRaw = Number(market.config.maintenance_margin)
  const maintenance = Number.isFinite(maintenanceRaw) && maintenanceRaw > 0 ? 100 / maintenanceRaw : NaN
  const leverage = row.lv / 100
  const liquidationPrice = Number.isFinite(maintenance) && leverage > 0 ? row.sd === 1 ? entryPrice * (1 - 1 / leverage + maintenance) : entryPrice * (1 + 1 / leverage - maintenance) : NaN
  const pnl = new Decimal(markPrice).minus(entryPrice).mul(size).mul(row.sd === 1 ? 1 : -1)
  if (![entryPrice, markPrice, size, margin, leverage, liquidationPrice, pnl.toNumber()].every(Number.isFinite)) throw new Error('PERPL_POSITION_NORMALIZATION_INVALID')
  const timestamp = decodeTimestamp(row.at.t)
  return { bookId: `${row.acc}:${row.mkt}`, side: row.sd === 1 ? 'LONG' : 'SHORT', size, entryPrice, markPrice, liquidationPrice, leverage, unrealizedPnl: pnl.toNumber(), margin, status: mapPerplPositionStatus(row.st), timestamp, observedAt, liquidationEstimated: true }
}
export class PerplAdapter implements VenueAdapter {
  readonly config: PerplConfig
  private readonly http: VenueHttp
  private readonly history?: PerplHistory
  private readonly markHistory = new Map<number, number[]>()
  private readonly marketStream: PerplMarketStream
  constructor(environment: PerplEnvironment, signer?: ApiKeySigner, overrides: Partial<PerplConfig> = {}) { this.config = { ...perplNetworks[environment], ...overrides }; this.http = createHttp(this.config.restUrl); this.history = signer ? new PerplHistory(this.config.restUrl, signer) : undefined; this.marketStream = new PerplMarketStream(this.config.wsUrl) }
  async getProtocolContext() { return this.http.get<PerplContext>('/v1/pub/context') }
  async getMarket(marketId: number) { const context = await this.getProtocolContext(); return context.markets.find(market => market.id === marketId) ?? null }
  async getMarketState(marketId: number) { const market = await this.getMarket(marketId) as PerplContext['markets'][number] | null; return market?.state ?? null }
  async getOrderBook(marketId: number) { return this.readMarketSnapshot(`order-book@${marketId}`, 15) }
  async getTrades(marketId: number) { return this.readMarketSnapshot(`trades@${marketId}`, 17) }
  async getNormalizedMarket(marketId: number): Promise<NormalizedTelemetry | null> {
    await this.marketStream.ensure([marketId])
    let state = await this.marketStream.snapshot(marketId)
    if (!state) return null
    const context = await this.getProtocolContext()
    const market = context.markets.find(item => item.id === marketId)
    if (!market) return null
    const funding = normalizeContextFunding(market, context.chain)
    const priceDecimals = Number(market?.config?.price_decimals ?? 0)
    const sizeDecimals = Number(market?.config?.size_decimals ?? 0)
    // Keep the context snapshot in wire units here. The selected market state
    // is normalized exactly once below, after choosing the freshest source.
    const contextMarket = market.state
    const streamedAt = Number((state.market?.at as Record<string, unknown> | undefined)?.t ?? 0)
    const contextAt = decodeTimestamp((market.state.at as Record<string, unknown> | undefined)?.t) ?? 0
    // Public context is authoritative fallback when market-state WS has stopped
    // advancing. Keep orderbook snapshot separate so its age remains visible.
    if (!state.market || contextAt > streamedAt) state = { ...state, market: contextMarket }
    state = { ...state, fundingRate: funding.rate, fundingTimestamp: funding.verifiedAt }
    if (state.market) state = { ...state, market: scaleMarketState(state.market, priceDecimals, sizeDecimals) }
    if (state.book) state = { ...state, book: { ...state.book, bids: state.book.bids.map(level => ({ ...level, p: decodePrice(level.p, priceDecimals), s: decodeSize(level.s, sizeDecimals) })), asks: state.book.asks.map(level => ({ ...level, p: decodePrice(level.p, priceDecimals), s: decodeSize(level.s, sizeDecimals) })) } }
    const scaledMarket = state.market as Record<string, unknown> | undefined
    const mark = Number(scaledMarket?.mrk)
    if (Number.isFinite(mark) && mark > 0) { const history = [...(this.markHistory.get(marketId) ?? []), mark].slice(-120); this.markHistory.set(marketId, history); state = { ...state, candleCloses: history } }
    const telemetry = normalizeMarketStream(state, 'perpl-rest')
    if (telemetry?.freshness) telemetry.freshness.funding.effectiveAt = funding.effectiveAt
    return telemetry
  }
  async getFunding(marketId: number) { const market = await this.getMarket(marketId) as PerplContext['markets'][number] | null; return market?.funding ?? null }
  async getPositions(accountId: number, marketId?: number): Promise<WirePosition[]> { if (!this.history) throw new Error('PERPL_SIGNER_NOT_CONFIGURED'); return this.history.read<WirePosition>('position-history', item => item.acc === accountId && (marketId === undefined || item.mkt === marketId)) }
  async getOrders(accountId: number, marketId?: number): Promise<WireOrder[]> { if (!this.history) throw new Error('PERPL_SIGNER_NOT_CONFIGURED'); return this.history.read<WireOrder>('order-history', item => item.acc === accountId && (marketId === undefined || item.mkt === marketId)) }
  async getFills(accountId: number, marketId?: number): Promise<WireFill[]> { if (!this.history) throw new Error('PERPL_SIGNER_NOT_CONFIGURED'); return this.history.read<WireFill>('fills', item => item.acc === accountId && (marketId === undefined || item.mkt === marketId)) }
  async getPosition(accountId: number, marketId: number, positionId?: number): Promise<Position | null> {
    const rows = await this.getPositions(accountId, marketId)
    const row = newestHistory(positionId === undefined ? rows : rows.filter(item => item.pid === positionId))
    if (!row) return null
    const context = await this.getProtocolContext()
    const market = context.markets.find(item => item.id === marketId)
    if (!market) throw new Error('PERPL_MARKET_NOT_FOUND')
    const instance = context.instances.find(item => item.id === market.instance_id)
    const token = context.tokens.find(item => item.id === instance?.collateral_token_id)
    return normalizePerplPosition(row, market, token?.decimals ?? 6)
  }
  async getBalance(accountId: number): Promise<PerplBalance> {
    if (!this.history) throw new Error('PERPL_SIGNER_NOT_CONFIGURED')
    const rows = await this.history.read<{ id: number; b: string; lb: string; at?: { b?: number; t?: number } }>('account-history', item => item.id === accountId)
    const row = newestHistory(rows)
    if (!row) throw new Error('PERPL_ACCOUNT_HISTORY_EMPTY')
    const context = await this.getProtocolContext()
    const account = context.instances.find(instance => context.tokens.some(token => token.id === instance.collateral_token_id))
    const token = context.tokens.find(item => item.id === account?.collateral_token_id)
    return normalizePerplBalance(row.b, row.lb, token?.decimals ?? 6, decodeTimestamp(row.at?.t))
  }
  async submit(_action: Action): Promise<{ venueReference: string; status: 'SUBMITTED' | 'CONFIRMED' | 'UNKNOWN' | 'FAILED' }> { throw new Error('PERPL_TRADING_USES_AUTHENTICATED_WS_CLIENT') }
  async reconcile(action: Action): Promise<Action> { return { ...action, status: 'UNKNOWN', error: 'PERPL_RECONCILIATION_REQUIRES_CONTEXT' } }

  private async readMarketSnapshot(stream: string, messageType: number): Promise<unknown> {
    const socket = new WS(`${this.config.wsUrl}/ws/v1/market-data`)
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('PERPL_MARKET_SNAPSHOT_TIMEOUT')) }, 10_000)
      socket.once('error', error => { clearTimeout(timer); reject(error) })
      socket.on('message', raw => { let message: { mt?: number }; try { message = JSON.parse(String(raw)) as { mt?: number } } catch { return }; if (message.mt !== messageType) return; clearTimeout(timer); socket.close(); resolve(message) })
      socket.once('open', () => socket.send(JSON.stringify({ mt: 5, subs: [{ stream, subscribe: true }] })))
    })
  }
  async connect(streams: string[], onMessage: (message: unknown) => void) { const socket = new WebSocket(this.config.wsUrl); socket.onmessage = event => { try { onMessage(JSON.parse(event.data as string)) } catch { onMessage({ type: 'MALFORMED_EVENT', raw: event.data }) } }; await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('PERPL_WS_CONNECT_FAILED')) }); socket.send(JSON.stringify({ mt: 5, subs: streams.map(stream => ({ stream, subscribe: true })) })); return () => { socket.close() } }
  close() { this.marketStream.close() }
}
export function normalizePerplTelemetry(raw: { state: { mrk: number; orl: number; bid: number; ask: number; mid: number; dv: number; oi: number }; funding: { rate: number }; block: number; timestamp: number; depthNotional: number; volatility?: number }, source: NormalizedTelemetry['source']): NormalizedTelemetry { return { mark: raw.state.mrk, oracle: raw.state.orl, bid: raw.state.bid, ask: raw.state.ask, mid: raw.state.mid, spreadBps: raw.state.mid > 0 ? (raw.state.ask - raw.state.bid) / raw.state.mid * 10000 : Infinity, fundingRate: raw.funding.rate, depthNotional: raw.depthNotional, volatility: raw.volatility ?? Number.NaN, volume24h: raw.state.dv, openInterest: raw.state.oi, block: raw.block, timestamp: raw.timestamp, source, freshnessMs: Date.now() - raw.timestamp } }





export function newestHistory<T extends { at?: { b?: number; t?: number; tx?: number; l?: number } }>(rows: T[]): T | undefined {
  return [...rows].sort((a, b) => { const av = a.at ?? {}, bv = b.at ?? {}; return ((bv.b ?? 0) - (av.b ?? 0)) || ((bv.t ?? 0) - (av.t ?? 0)) || ((bv.tx ?? 0) - (av.tx ?? 0)) || ((bv.l ?? 0) - (av.l ?? 0)) })[0]
}


function scaleMarketState(raw: Record<string, unknown>, priceDecimals: number, sizeDecimals: number): Record<string, unknown> {
  const scaled = { ...raw }
  for (const key of ['orl', 'mrk', 'lst', 'mid', 'bid', 'ask', 'prv']) if (typeof raw[key] === 'number') scaled[key] = decodePrice(raw[key] as number, priceDecimals)
  for (const key of ['dv', 'oi']) if (typeof raw[key] === 'number') scaled[key] = decodeSize(raw[key] as number, sizeDecimals)
  return scaled
}


