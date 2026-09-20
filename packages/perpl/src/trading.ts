import WS from 'ws'
import { createNonce, type Ed25519PerplSigner } from './signer.js'
import type { Action } from '../../domain/src/index.js'
import type { PerplConfig } from './index.js'
import { PerplStateStore } from './decoder.js'

export type PerplOrder = { mkt: number; acc: number; t: number; s: number; lv: number; a?: string; lb?: number; p?: number; ms?: number; lp?: number }
export type PerplSubmitStatus = 'SUBMITTED' | 'CONFIRMED' | 'PARTIAL' | 'CANCELED' | 'EXPIRED' | 'FAILED' | 'UNKNOWN'
type Pending = { rq: number; accountId: number; action: Action; resolve: (value: { venueReference: string; status: PerplSubmitStatus }) => void; timer: ReturnType<typeof setTimeout> }

type TradingMessage = { mt?: number; cid?: number; rq?: number; st?: number; oid?: number; status?: { code?: number; error?: string }; d?: Array<{ rq?: number; st?: number; oid?: number; r?: boolean }> }
export type PerplTradingLifecycle = 'DISCONNECTED' | 'CONNECTING' | 'AUTHENTICATING' | 'AUTHENTICATED' | 'SNAPSHOTS_READY' | 'READY' | 'STALE' | 'RECONNECTING' | 'FAILED'
export function mapPerplOrderStatus(status: number): PerplSubmitStatus {
  if (status === 7) return 'FAILED'
  if (status === 3) return 'PARTIAL'
  if (status === 5) return 'CANCELED'
  if (status === 6) return 'EXPIRED'
  if ([2, 4, 8, 9, 10].includes(status)) return 'CONFIRMED'
  return 'SUBMITTED'
}
export class PerplTradingClient {
  private socket?: WS
  private sequence = 0
  private requestId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly state = new PerplStateStore()
  private lifecycle: PerplTradingLifecycle = 'DISCONNECTED'
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private connecting?: Promise<void>
  private reconnectAttempt = 0
  private stopped = false
  private authenticationFailed = false
  private readyWaiter?: { resolve: () => void; reject: (error: Error) => void }
  private readonly diagnostic: (line: string) => void
  constructor(private readonly config: PerplConfig, private readonly signer: Ed25519PerplSigner, diagnostic: (line: string) => void = line => console.info(line)) { this.diagnostic = diagnostic }
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting
    this.stopped = false
    this.authenticationFailed = false
    this.lifecycle = this.reconnectAttempt > 0 ? 'RECONNECTING' : 'CONNECTING'
    this.connecting = this.openAndAuthenticate().finally(() => { this.connecting = undefined })
    return this.connecting
  }
  async submit(action: Action, order: PerplOrder, beforeSend: (reference: string) => Promise<void> = async () => undefined): Promise<{ venueReference: string; status: PerplSubmitStatus }> {
    if (!this.socket || this.socket.readyState !== WS.OPEN) throw new Error('PERPL_TRADING_NOT_CONNECTED')
    if (!this.state.ready()) throw new Error('PERPL_TRADING_STATE_UNTRUSTED')
    const account = this.state.snapshot().accounts.find(item => item.id === order.acc)
    if (!account || account.fr || !account.fw) throw new Error('PERPL_ACCOUNT_NOT_AUTHORIZED')
    this.requestId = Math.max(this.requestId, this.state.requestIdBaseline(order.acc)) + 1
    if (!Number.isSafeInteger(this.requestId)) throw new Error('PERPL_REQUEST_ID_OVERFLOW')
    const rq = this.requestId, sn = ++this.sequence, reference = `${order.acc}:${rq}`
    await beforeSend(reference)
    return await new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(sn); resolve({ venueReference: reference, status: 'UNKNOWN' }) }, 15_000)
      this.pending.set(sn, { rq, accountId: order.acc, action, timer, resolve })
      this.socket!.send(JSON.stringify({ mt: 22, sn, rq, ...order, fl: 4 }), error => {
        if (!error) return
        clearTimeout(timer); this.pending.delete(sn); resolve({ venueReference: reference, status: 'UNKNOWN' })
      })
    })
  }
  stateSnapshot() { return this.state.snapshot() }
  isReady() {
    const ready = this.state.ready()
    if (ready && this.lifecycle === 'AUTHENTICATED') this.lifecycle = 'SNAPSHOTS_READY'
    if (ready && this.lifecycle === 'SNAPSHOTS_READY') this.lifecycle = 'READY'
    if (!ready && this.lifecycle === 'READY') this.lifecycle = 'STALE'
    return ready
  }
  lifecycleState() { return this.lifecycle }
  close() { this.stopped = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.socket?.close(); this.socket = undefined; this.state.disconnect(); this.lifecycle = 'DISCONNECTED'; this.failPending('UNKNOWN') }
  private async openAndAuthenticate(): Promise<void> {
    const socket = new WS(`${this.config.wsUrl}/ws/v1/trading`)
    this.socket = socket
    socket.on('message', data => this.handleMessage(String(data)))
    socket.on('close', (code, reason) => {
      this.diagnostic(`PERPL_WS_CLOSE code=${code} reason=${JSON.stringify(String(reason))}`)
      this.state.disconnect(); this.failPending('UNKNOWN'); this.socket = undefined
      const waiter = this.readyWaiter; this.readyWaiter = undefined; waiter?.reject(new Error('PERPL_WS_DISCONNECTED'))
      if (!this.stopped && !this.authenticationFailed) { this.lifecycle = 'RECONNECTING'; this.scheduleReconnect() } else if (!this.stopped) this.lifecycle = 'FAILED'
    })
    socket.on('error', error => { this.diagnostic(`PERPL_WS_ERROR reason=${JSON.stringify(error instanceof Error ? error.message : String(error))}`); this.state.disconnect(); this.failPending('UNKNOWN') })
    try {
      await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
    } catch (error) {
      this.diagnostic(`PERPL_WS_ERROR reason=${JSON.stringify(error instanceof Error ? error.message : String(error))}`)
      this.state.disconnect(); this.lifecycle = 'RECONNECTING'; this.scheduleReconnect(); throw new Error('PERPL_WS_CONNECT_FAILED')
    }
    this.lifecycle = 'AUTHENTICATING'; this.diagnostic('PERPL_WS_OPEN')
    const timestamp = String(Date.now()); const nonce = createNonce(); const signature = await this.signer.signWebSocket(timestamp, nonce)
    socket.send(JSON.stringify({ mt: 29, chain_id: this.config.chainId, api_key: this.signer.apiKey, timestamp, nonce, signature }))
    this.diagnostic('PERPL_WS_SIGNIN_SENT')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        this.readyWaiter = { resolve, reject }
        timer = setTimeout(() => { this.readyWaiter = undefined; reject(new Error('PERPL_WS_SNAPSHOT_TIMEOUT')) }, 15_000)
      })
      return
    } catch (error) {
      if (error instanceof Error && error.message === 'PERPL_WS_SNAPSHOT_TIMEOUT') { this.lifecycle = 'STALE'; this.diagnostic('PERPL_WS_SNAPSHOT_TIMEOUT'); this.scheduleReconnect() }
      throw error
    } finally { if (timer) clearTimeout(timer) }
  }
  private scheduleReconnect() {
    if (this.stopped || this.authenticationFailed || this.reconnectTimer || this.connecting) return
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt++, 5))
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect().catch(() => undefined) }, delay)
  }
  private handleMessage(raw: string) {
    let message: TradingMessage
    try {
      message = JSON.parse(raw) as TradingMessage
      this.diagnostic(`PERPL_WS_MESSAGE mt=${message.mt ?? 'unknown'}`)
      const applied = this.state.apply(message)
      if (message.mt === 19) this.diagnostic('PERPL_WS_SNAPSHOT mt=19')
      if (message.mt === 23) this.diagnostic('PERPL_WS_SNAPSHOT mt=23')
      if (message.mt === 26) this.diagnostic('PERPL_WS_SNAPSHOT mt=26')
      if (message.mt === 100) {
        this.diagnostic('PERPL_WS_HEARTBEAT mt=100')
        if (applied && 'accepted' in applied && applied.accepted === false) { this.diagnostic(`PERPL_WS_HEARTBEAT_REJECTED reason=${applied.reason}`); this.lifecycle = 'STALE'; this.socket?.close(); return }
      }
      if (message.mt === 19 && this.lifecycle === 'AUTHENTICATING') this.lifecycle = 'AUTHENTICATED'
      if (this.state.snapshotsReady() && this.lifecycle === 'AUTHENTICATED') this.lifecycle = 'SNAPSHOTS_READY'
      if (this.state.ready()) { if (this.lifecycle !== 'READY') this.diagnostic('PERPL_WS_READY'); this.lifecycle = 'READY'; const waiter = this.readyWaiter; this.readyWaiter = undefined; waiter?.resolve() }
    } catch (error) {
      this.diagnostic(`PERPL_WS_DECODE_ERROR reason=${JSON.stringify(error instanceof Error ? error.message : String(error))}`)
      this.state.disconnect(); this.lifecycle = 'STALE'; this.failPending('UNKNOWN'); const waiter = this.readyWaiter; this.readyWaiter = undefined; waiter?.reject(new Error('PERPL_WS_DECODE_FAILED')); this.socket?.close(); return
    }
    if (message.mt === 3) {
      this.diagnostic(`PERPL_WS_AUTH_RESPONSE code=${message.status?.code ?? 'unknown'}`)
      if (message.status?.code !== 0) { this.authenticationFailed = true; this.lifecycle = 'FAILED'; const waiter = this.readyWaiter; this.readyWaiter = undefined; waiter?.reject(new Error('PERPL_WS_AUTH_FAILED')); this.socket?.close(); return }
      this.lifecycle = 'AUTHENTICATED'
      const pending = message.cid === undefined ? undefined : this.pending.get(message.cid)
      if (!pending || message.status?.code === 0) return
      clearTimeout(pending.timer); this.pending.delete(message.cid as number); pending.resolve({ venueReference: `${pending.accountId}:${pending.rq}`, status: 'FAILED' }); return
    }
    if (message.mt !== 24 || !message.d) return
    for (const order of message.d) { const entry = [...this.pending.entries()].find(([, value]) => value.rq === order.rq); if (!entry) continue; const [sn, pending] = entry; const status = mapPerplOrderStatus(order.st ?? 0); if (status === 'SUBMITTED') continue; clearTimeout(pending.timer); this.pending.delete(sn); pending.resolve({ venueReference: `${pending.accountId}:${pending.rq}:${order.oid ?? pending.rq}`, status }) }
  }
  private failPending(status: PerplSubmitStatus) { for (const [sn, pending] of this.pending) { clearTimeout(pending.timer); pending.resolve({ venueReference: `${pending.accountId}:${pending.rq}`, status }); this.pending.delete(sn) } }
}
