import WS from 'ws'
import { createNonce, type Ed25519PerplSigner } from './signer.js'
import type { Action } from '../../domain/src/index.js'
import type { PerplConfig } from './index.js'
import { PerplStateStore } from './decoder.js'

export type PerplOrder = { mkt: number; acc: number; t: number; s: number; lv: number; a?: string; lb?: number; p?: number; ms?: number; lp?: number }
export type PerplSubmitStatus = 'SUBMITTED' | 'CONFIRMED' | 'PARTIAL' | 'CANCELED' | 'EXPIRED' | 'FAILED' | 'UNKNOWN'
type Pending = { rq: number; accountId: number; action: Action; resolve: (value: { venueReference: string; status: PerplSubmitStatus }) => void; timer: ReturnType<typeof setTimeout> }

type TradingMessage = { mt?: number; cid?: number; rq?: number; st?: number; oid?: number; status?: { code?: number; error?: string }; d?: Array<{ rq?: number; st?: number; oid?: number; r?: boolean }> }
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
  constructor(private readonly config: PerplConfig, private readonly signer: Ed25519PerplSigner) {}
  async connect(): Promise<void> {
    const socket = new WS(`${this.config.wsUrl}/ws/v1/trading`)
    this.socket = socket
    socket.on('message', data => this.handleMessage(String(data)))
    socket.on('close', () => { this.state.disconnect(); this.failPending('UNKNOWN') })
    socket.on('error', () => { this.state.disconnect(); this.failPending('UNKNOWN') })
    await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
    const timestamp = String(Date.now()); const nonce = createNonce(); const signature = await this.signer.signWebSocket(timestamp, nonce)
    socket.send(JSON.stringify({ mt: 29, chain_id: this.config.chainId, api_key: this.signer.apiKey, timestamp, nonce, signature }))
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
  isReady() { return this.state.ready() }
  close() { this.socket?.close(); this.socket = undefined; this.failPending('UNKNOWN') }
  private handleMessage(raw: string) {
    let message: TradingMessage
    try { message = JSON.parse(raw) as TradingMessage; this.state.apply(message) } catch { this.state.disconnect(); this.failPending('UNKNOWN'); this.socket?.close(); return }
    if (message.mt === 3) {
      const pending = message.cid === undefined ? undefined : this.pending.get(message.cid)
      if (!pending || message.status?.code === 0) return
      clearTimeout(pending.timer); this.pending.delete(message.cid as number); pending.resolve({ venueReference: `${pending.accountId}:${pending.rq}`, status: 'FAILED' }); return
    }
    if (message.mt !== 24 || !message.d) return
    for (const order of message.d) { const entry = [...this.pending.entries()].find(([, value]) => value.rq === order.rq); if (!entry) continue; const [sn, pending] = entry; const status = mapPerplOrderStatus(order.st ?? 0); if (status === 'SUBMITTED') continue; clearTimeout(pending.timer); this.pending.delete(sn); pending.resolve({ venueReference: `${pending.accountId}:${pending.rq}:${order.oid ?? pending.rq}`, status }) }
  }
  private failPending(status: PerplSubmitStatus) { for (const [sn, pending] of this.pending) { clearTimeout(pending.timer); pending.resolve({ venueReference: `${pending.accountId}:${pending.rq}`, status }); this.pending.delete(sn) } }
}
