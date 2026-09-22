import WS from 'ws'
import { applyMarketMessage, type MarketStreamState, type L2Level } from './marketDecoder.js'
import { defaultFreshnessThresholds } from '../../domain/src/index.js'

type Subscription = { stream: string; sid?: number }
type Frame = { mt?: number; subs?: Array<{ stream?: string; sid?: number; status?: { code?: number } }>; d?: Record<string, Record<string, unknown>>; sid?: number; bid?: L2Level[]; ask?: L2Level[]; at?: { b?: number; t?: number } }

/** One market-data socket shared by all Books in a process. */
export class PerplMarketStream {
  private socket?: WS
  private connecting?: Promise<void>
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly states = new Map<number, MarketStreamState>()
  private lastUpdateAt = 0
  private connectedAt = 0
  private nextResyncAt = 0
  private stopped = false

  constructor(private readonly wsUrl: string) {}

  async ensure(marketIds: number[]): Promise<void> {
    this.stopped = false
    for (const marketId of marketIds) {
      const stream = `order-book@${marketId}`
      if (!this.subscriptions.has(stream)) this.subscriptions.set(stream, { stream })
    }
    const marketStateStream = `market-state@${this.wsUrl.includes('testnet') ? 10143 : 143}`
    if (!this.subscriptions.has(marketStateStream)) this.subscriptions.set(marketStateStream, { stream: marketStateStream })
    const now = Date.now()
    // An OPEN socket is not proof that every subscription is advancing.
    // Rebuild from venue snapshots; never freshen cached depth with a heartbeat.
    const stalled = now - (this.lastUpdateAt || this.connectedAt) > defaultFreshnessThresholds.orderbookMs || marketIds.some(id => {
      const timestamp = this.states.get(id)?.book?.timestamp
      return now - (timestamp || this.connectedAt) > defaultFreshnessThresholds.orderbookMs
    })
    if (this.socket?.readyState === WS.OPEN && stalled && now >= this.nextResyncAt) {
      this.nextResyncAt = now + 30_000 // Bound recovery attempts independently of the safety threshold.
      const socket = this.socket
      this.socket = undefined
      this.invalidate()
      socket.terminate()
    }
    const wasConnected = this.socket?.readyState === WS.OPEN
    if (!wasConnected) await this.connect()
    const pending = [...this.subscriptions.values()].filter(item => item.sid === undefined)
    if (pending.length && wasConnected) this.socket?.send(JSON.stringify({ mt: 5, subs: pending.map(item => ({ stream: item.stream, subscribe: true })) }))
  }

  async snapshot(marketId: number, timeoutMs = 5000): Promise<MarketStreamState | null> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const state = this.states.get(marketId)
      if (state?.market && state.book) return state
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return this.states.get(marketId) ?? null
  }

  health(maxAgeMs = 10_000) { return { connected: this.socket?.readyState === WS.OPEN, fresh: this.lastUpdateAt > 0 && Date.now() - this.lastUpdateAt <= maxAgeMs, lastUpdateAt: this.lastUpdateAt } }

  close() { this.stopped = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.socket?.close(); this.socket = undefined; this.invalidate() }

  private invalidate() { this.states.clear(); this.lastUpdateAt = 0; for (const item of this.subscriptions.values()) item.sid = undefined }

  private async connect() {
    if (this.connecting) return this.connecting
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WS(`${this.wsUrl}/ws/v1/market-data`)
      this.socket = socket
      socket.on('open', () => { if (this.socket !== socket) return; this.connectedAt = Date.now(); this.nextResyncAt = Math.max(this.nextResyncAt, this.connectedAt + 30_000); this.resubscribe(); resolve() })
      socket.on('message', raw => { if (this.socket === socket) this.handle(String(raw)) })
      socket.on('error', () => undefined)
      socket.on('close', () => { if (this.socket !== socket) return; this.socket = undefined; this.connecting = undefined; this.invalidate(); reject(new Error('PERPL_MARKET_STREAM_CLOSED')); if (!this.stopped) this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect().catch(() => undefined) }, 1000) })
      socket.once('error', reject)
    }).finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private resubscribe() { const streams = [...this.subscriptions.values()]; if (streams.length) this.socket?.send(JSON.stringify({ mt: 5, subs: streams.map(item => ({ stream: item.stream, subscribe: true })) })) }

  private handle(raw: string) {
    let frame: Frame
    try { frame = JSON.parse(raw) as Frame } catch { return }
    this.lastUpdateAt = Date.now()
    if (frame.mt === 6) { for (const item of frame.subs ?? []) { if (item.stream && item.sid !== undefined && item.status?.code === 0) { const subscription = this.subscriptions.get(item.stream); if (subscription) subscription.sid = item.sid } }; return }
    if (frame.mt === 9) { for (const [id, market] of Object.entries(frame.d ?? {})) { const marketId = Number(id); const prior = this.states.get(marketId) ?? { fundingRate: Number.NaN, candleCloses: [] }; this.states.set(marketId, applyMarketMessage(prior, { mt: 9, d: market })) }; return }
    if (frame.mt === 15 || frame.mt === 16) { const stream = [...this.subscriptions.values()].find(item => item.sid === frame.sid)?.stream; const match = stream?.match(/^order-book@(\d+)$/); if (!match) return; const marketId = Number(match[1]); const prior = this.states.get(marketId) ?? { fundingRate: Number.NaN, candleCloses: [] }; this.states.set(marketId, applyMarketMessage(prior, frame)); return }
    if (frame.mt === 11 || frame.mt === 12) { for (const [marketId, prior] of this.states) this.states.set(marketId, applyMarketMessage(prior, frame)) }
  }
}
