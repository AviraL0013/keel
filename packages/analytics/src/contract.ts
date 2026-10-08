/** Public Analytics API v1. Decimal quantities are strings; unavailable values are null. */
export type Money = string
export type DecimalText = string
export type Window = '24h' | '7d' | '30d' | 'all'
export type Interval = '1h' | '1d'
export type Metric = 'volume' | 'oi' | 'tvl' | 'fees' | 'active_users' | 'net_flows'
export type Source = 'perpl_api' | 'monad_exchange' | 'derived' | 'external'

export interface Envelope<T> {
  asOf: string // ISO 8601 UTC observation time
  block: number | null // latest finalized Monad block represented
  source: Source
  stale: boolean
  coverage?: {
    from: string | null // earliest indexed event/block time; null before backfill
    through: string | null // most recent indexed block time
    completeHistory: boolean // true only when starting from the configured deployment block and caught up
    label: string // display label, for example "Since 2026-10-01"
  }
  data: T
}

export interface WindowValue {
  value: Money | null
  previous: Money | null
  changePct: DecimalText | null // null for all-time or zero/missing baseline
}

export interface ProtocolSummary {
  window: Window
  volume: WindowValue
  fees: WindowValue
  revenue: WindowValue
  activeUsers: WindowValue
  liquidations: WindowValue
  openInterest: WindowValue // end-of-window snapshot, compared with prior boundary
  tvl: WindowValue // end-of-window snapshot, compared with prior boundary
  netFlows: WindowValue
}

export interface TimePoint {
  time: string
  value: Money | null
}
export interface ProtocolTimeseries {
  metric: Metric
  interval: Interval
  from: string
  to: string
  points: TimePoint[]
}
export interface FlowBucket {
  time: string
  deposits: Money
  withdrawals: Money
  net: Money
}
export interface ProtocolFlows {
  window: Window
  deposits: Money | null
  withdrawals: Money | null
  net: Money | null
  buckets: FlowBucket[]
}

export interface MarketSummary {
  id: number
  symbol: string
  volume24h: Money | null
  openInterest: Money | null
  longOpenInterest: Money | null
  shortOpenInterest: Money | null
  longSharePct: DecimalText | null
  fundingRate: DecimalText | null // signed fraction per funding interval
  markPrice: DecimalText | null
}
export interface MarketDetail extends MarketSummary {
  tvl: Money | null
  priceDecimals: number
  sizeDecimals: number
  fundingIntervalSeconds: number
}
export interface FundingPoint {
  time: string
  block: number | null
  rate: DecimalText
}
export interface MarketFunding {
  marketId: number
  points: FundingPoint[]
}
export interface MarketPrices {
  marketId: number
  interval: Interval
  from: string
  to: string
  points: TimePoint[] // completed candle closes at candle open timestamps; missing/in-progress values are null
}

export interface Liquidation {
  id: string // block:transactionHash:logIndex
  time: string
  marketId: number
  address: string | null
  side: 'long' | 'short' | null
  notional: Money | null
  realizedPnl: Money | null
  transactionHash: string
}
export interface LiquidationPage {
  items: Liquidation[]
  nextCursor: string | null
  summary: { count: number; notional: Money | null }
}

export interface WalletSearch {
  items: Array<{ address: string; accountId: string | null }>
}
export interface Position {
  id: string
  marketId: number
  symbol: string
  side: 'long' | 'short'
  size: DecimalText
  notional: Money | null
  entryPrice: DecimalText
  markPrice: DecimalText | null
  leverage: DecimalText
  collateral: Money
  unrealizedPnl: Money | null
  liquidationPrice: DecimalText | null
  openedAt: string
}
export interface WalletProfile {
  address: string
  accountIds: string[]
  margin: { balance: Money | null; locked: Money | null; free: Money | null; equity: Money | null }
  positions: Position[]
}
export interface Trade {
  id: string
  time: string
  marketId: number
  side: 'long' | 'short'
  action: 'open' | 'increase' | 'reduce' | 'close' | 'liquidation'
  size: DecimalText
  price: DecimalText
  notional: Money
  fee: Money | null
  realizedPnl: Money | null
  transactionHash: string
}
export interface TradePage {
  items: Trade[]
  nextCursor: string | null
}
export interface WalletPerformance {
  address: string
  realizedPnl: Money | null
  winRatePct: DecimalText | null
  profitFactor: DecimalText | null
  maxDrawdownPct: DecimalText | null
  currentStreak: number
  longestWinStreak: number
  longestLossStreak: number
  averageHoldSeconds: number | null
  bestMarketId: number | null
  worstMarketId: number | null
  closedTrades: number
  equityCurve: TimePoint[]
}
export interface WalletCompare {
  wallets: WalletPerformance[]
}

export interface AnalyticsResponses {
  'GET /protocol/summary': Envelope<ProtocolSummary>
  'GET /protocol/timeseries': Envelope<ProtocolTimeseries>
  'GET /protocol/flows': Envelope<ProtocolFlows>
  'GET /markets': Envelope<{ items: MarketSummary[] }>
  'GET /markets/:id': Envelope<MarketDetail>
  'GET /markets/:id/funding': Envelope<MarketFunding>
  'GET /markets/:id/prices': Envelope<MarketPrices>
  'GET /liquidations': Envelope<LiquidationPage>
  'GET /search': Envelope<WalletSearch>
  'GET /wallets/:address': Envelope<WalletProfile>
  'GET /wallets/:address/trades': Envelope<TradePage>
  'GET /wallets/:address/performance': Envelope<WalletPerformance>
  'GET /wallets/compare': Envelope<WalletCompare>
}
