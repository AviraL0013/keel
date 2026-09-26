import WS from 'ws'
import { createNonce, type Ed25519PerplSigner } from './signer.js'
import type { Action } from '../../domain/src/index.js'
import type { PerplConfig } from './index.js'
import { PerplStateStore } from './decoder.js'
import { forwardedRequestDelta, orderFrameWithRequestId, parsePerplRequestIds, requestId, validForwardedRequestId } from './request-id.js'

export type PerplOrder = { mkt: number; acc: number; t: number; s: number; lv: number; a?: string; lb?: number; p?: number; ms?: number; lp?: number }
export type PerplSubmitStatus = 'SUBMITTED' | 'CONFIRMED' | 'PARTIAL' | 'CANCELED' | 'EXPIRED' | 'FAILED' | 'UNKNOWN'
export type PerplSubmitResult = { venueReference: string; status: PerplSubmitStatus; reason?: string }
export class PerplPreSubmissionError extends Error { readonly preSubmission = true; constructor(message: string, readonly statusCode?: number) { super(message) } }
type Pending = { rq: string; accountId: number; action: Action; resolve: (value: PerplSubmitResult) => void; timer: ReturnType<typeof setTimeout> }

type TradingMessage = { mt?: number; cid?: number; rq?: string | number; st?: number; oid?: number; status?: { code?: number; error?: string }; d?: Array<{ rq?: string | number; st?: number; sr?: number; oid?: number; r?: boolean }> }
export type PerplTradingLifecycle = 'DISCONNECTED' | 'CONNECTING' | 'AUTHENTICATING' | 'AUTHENTICATED' | 'SNAPSHOTS_READY' | 'READY' | 'STALE' | 'RECONNECTING' | 'FAILED'
type ForwardedRequestBaseline = { lfr: string; rejectedForwardedRq: string }
type HistoricalOrderRequest = { acc: number; rq?: string | number; st?: number; sr?: number }
export function highestOrderDescIdRejection(orders: HistoricalOrderRequest[], accountId: number): bigint {
  let highest = 0n
  for (const order of orders) {
    if (order.acc !== accountId) continue
    const id = requestId(order.rq)
    if (order.st === 7 && order.sr === 32 && id > highest) highest = id
  }
  return highest
}
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
  private readonly pending = new Map<number, Pending>()
  private readonly state = new PerplStateStore()
  private lifecycle: PerplTradingLifecycle = 'DISCONNECTED'
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private connecting?: Promise<void>
  private reconnectAttempt = 0
  private stopped = false
  private authenticationFailed = false
  private lastHeartbeatDiagnosticAt = 0
  private readyWaiter?: { resolve: () => void; reject: (error: Error) => void }
  private readonly diagnostic: (line: string) => void
  constructor(private readonly config: PerplConfig, private readonly signer: Ed25519PerplSigner, diagnostic: (line: string) => void = line => console.info(line), private readonly allocateRequestId: (accountId: number, lfr: string, actionId: string, rejectedForwardedRq: string) => Promise<string> = async () => { throw new Error('PERPL_REQUEST_ID_ALLOCATOR_UNCONFIGURED') }, private readonly authoritativeBaseline: (accountId: number) => Promise<ForwardedRequestBaseline> = accountId => this.readAuthoritativeBaseline(accountId)) { this.diagnostic = diagnostic }
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting
    this.stopped = false
    this.authenticationFailed = false
    this.lifecycle = this.reconnectAttempt > 0 ? 'RECONNECTING' : 'CONNECTING'
    this.connecting = this.openAndAuthenticate().finally(() => { this.connecting = undefined })
    return this.connecting
  }
  async submit(action: Action, order: PerplOrder, beforeSend: (reference: string) => Promise<void> = async () => undefined): Promise<PerplSubmitResult> {
    if (!this.socket || this.socket.readyState !== WS.OPEN) throw new PerplPreSubmissionError('PERPL_TRADING_NOT_CONNECTED')
    if (!this.state.ready()) throw new PerplPreSubmissionError('PERPL_TRADING_STATE_UNTRUSTED')
    const account = this.state.snapshot().accounts.find(item => item.id === order.acc)
    if (!account) throw new PerplPreSubmissionError('PERPL_ACCOUNT_NOT_FOUND', 403)
    if (account.fr) throw new PerplPreSubmissionError('PERPL_ACCOUNT_FROZEN', 403)
    if (!account.fw) throw new PerplPreSubmissionError('PERPL_ORDER_FORWARDING_DISABLED', 403)
    let baseline: ForwardedRequestBaseline
    try { baseline = await this.authoritativeBaseline(order.acc) }
    catch { throw new PerplPreSubmissionError('PERPL_REQUEST_ID_BASELINE_UNAVAILABLE') }
    let lfr: bigint
    try { lfr = requestId(baseline.lfr); requestId(baseline.rejectedForwardedRq) }
    catch { throw new PerplPreSubmissionError('PERPL_REQUEST_ID_BASELINE_INVALID') }
    this.diagnostic(`PERPL_RQ_BASELINE account=${order.acc} lfr=${lfr}`)
    const streamLfr = this.state.requestIdBaseline(order.acc)
    const baselineDelta = forwardedRequestDelta(lfr.toString(), streamLfr)
    if (BigInt.asUintN(32, requestId(streamLfr)) !== BigInt.asUintN(32, lfr) && baselineDelta <= 0n) throw new PerplPreSubmissionError('PERPL_REQUEST_ID_BASELINE_CONTRADICTORY')
    // A numerically larger ID can still fail the contract's signed-32 serial comparison.
    // Only that explained rejection may be superseded. A serial-valid rejected ID stays blocked.
    if (requestId(baseline.rejectedForwardedRq) > lfr) {
      if (forwardedRequestDelta(baseline.rejectedForwardedRq, lfr.toString()) > 0n) {
        this.diagnostic(`PERPL_RQ_REJECTION_UNRESOLVED account=${order.acc} lfr=${lfr} rejectedRq=${baseline.rejectedForwardedRq}`)
        throw new PerplPreSubmissionError('PERPL_REQUEST_ID_FORWARDED_REJECTION_UNRESOLVED')
      }
      this.diagnostic(`PERPL_RQ_REJECTION_EXPLAINED account=${order.acc} lfr=${lfr} rejectedRq=${baseline.rejectedForwardedRq} reason=SIGNED_32_WINDOW`)
    }
    let rq: string
    try { rq = await this.allocateRequestId(order.acc, lfr.toString(), action.id, baseline.rejectedForwardedRq) }
    catch { throw new PerplPreSubmissionError('PERPL_REQUEST_ID_ALLOCATION_FAILED') }
    if (!validForwardedRequestId(rq, lfr.toString()) || requestId(rq) <= requestId(baseline.rejectedForwardedRq)) throw new PerplPreSubmissionError('PERPL_REQUEST_ID_ALLOCATION_INVALID')
    this.diagnostic(`PERPL_RQ_ALLOCATED account=${order.acc} rq=${rq} serialDelta=${forwardedRequestDelta(rq, lfr.toString())}`)
    const sn = ++this.sequence, reference = `${order.acc}:${rq}`
    await beforeSend(reference)
    // REST/history reads and durable persistence may outlast WS authority.
    if (!this.state.ready()) throw new PerplPreSubmissionError('PERPL_TRADING_STATE_UNTRUSTED')
    const latestAccount = this.state.snapshot().accounts.find(item => item.id === order.acc)
    if (!latestAccount || latestAccount.fr || !latestAccount.fw) throw new PerplPreSubmissionError('PERPL_ACCOUNT_AUTHORITY_CHANGED')
    if (!validForwardedRequestId(rq, String(latestAccount.lfr))) throw new PerplPreSubmissionError('PERPL_REQUEST_ID_BASELINE_CHANGED')
    return await new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(sn); this.diagnostic(`PERPL_WS_ORDER_TIMEOUT actionId=${action.id} rq=${rq} sn=${sn}`); resolve({ venueReference: reference, status: 'UNKNOWN', reason: 'PERPL_ORDER_RESPONSE_TIMEOUT' }) }, 15_000)
      this.pending.set(sn, { rq, accountId: order.acc, action, timer, resolve })
      this.diagnostic(`PERPL_WS_ORDER_SEND actionId=${action.id} mt=22 rq=${rq} sn=${sn} accountId=${order.acc} marketId=${order.mkt}`)
      this.socket!.send(orderFrameWithRequestId({ mt: 22, sn, ...order, fl: 4 }, rq), error => {
        if (!error) { this.diagnostic(`PERPL_WS_ORDER_WRITE_OK actionId=${action.id} rq=${rq} sn=${sn}`); return }
        this.diagnostic(`PERPL_WS_ORDER_WRITE_ERROR actionId=${action.id} rq=${rq} sn=${sn} reason=${JSON.stringify(error.message)}`)
        clearTimeout(timer); this.pending.delete(sn); resolve({ venueReference: reference, status: 'UNKNOWN', reason: 'PERPL_ORDER_TRANSPORT_AMBIGUOUS' })
      })
    })
  }
  stateSnapshot() { return this.state.snapshot() }
  positionSnapshot(accountId: number, marketId: number, positionId?: number) { return this.state.positionSnapshot(accountId, marketId, positionId) }
  isReady() {
    const ready = this.state.ready()
    if (ready && this.lifecycle === 'AUTHENTICATED') this.lifecycle = 'SNAPSHOTS_READY'
    if (ready && this.lifecycle === 'SNAPSHOTS_READY') this.lifecycle = 'READY'
    if (!ready && this.lifecycle === 'READY') this.lifecycle = 'STALE'
    return ready
  }
  lifecycleState() { return this.lifecycle }
  close() { this.stopped = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; this.socket?.close(); this.socket = undefined; this.state.disconnect(); this.lifecycle = 'DISCONNECTED'; this.failPending('UNKNOWN') }
  private async signedRead(target: string): Promise<string> {
    const timestamp = String(Date.now()), nonce = createNonce()
    const signature = await this.signer.sign('GET', target, '', timestamp, nonce)
    const response = await fetch(`${this.config.restUrl.replace(/\/$/, '')}${target}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000), headers: { 'X-API-Key': this.signer.apiKey, 'X-API-Timestamp': timestamp, 'X-API-Nonce': nonce, 'X-API-Signature': signature } })
    if (!response.ok) throw new Error(`PERPL_BASELINE_HTTP_${response.status}`)
    return response.text()
  }
  private async readAuthoritativeBaseline(accountId: number): Promise<ForwardedRequestBaseline> {
    const wallet = parsePerplRequestIds(await this.signedRead('/v1/trading/wallet')) as { as?: Array<{ id: number; lfr?: string | number }> }
    const account = wallet.as?.find(value => value.id === accountId)
    if (!account) throw new Error('PERPL_ACCOUNT_SNAPSHOT_REQUIRED')
    const lfr = requestId(account.lfr)
    let rejected = 0n, page: string | undefined
    const seen = new Set<string>()
    for (let index = 0; index < 100; index++) {
      const query = new URLSearchParams({ count: '100' })
      if (page) query.set('page', page)
      const history = parsePerplRequestIds(await this.signedRead(`/v1/trading/order-history?${query}`)) as { d?: HistoricalOrderRequest[]; np?: string }
      if (!Array.isArray(history.d)) throw new Error('PERPL_ORDER_HISTORY_INVALID')
      const pageRejection = highestOrderDescIdRejection(history.d, accountId)
      if (pageRejection > rejected) rejected = pageRejection
      if (!history.np) return { lfr: lfr.toString(), rejectedForwardedRq: rejected.toString() }
      if (seen.has(history.np)) throw new Error('PERPL_ORDER_HISTORY_CURSOR_LOOP')
      seen.add(history.np); page = history.np
    }
    throw new Error('PERPL_ORDER_HISTORY_SCAN_LIMIT')
  }
  private async openAndAuthenticate(): Promise<void> {
    const socket = new WS(`${this.config.wsUrl}/ws/v1/trading`)
    this.lastHeartbeatDiagnosticAt = 0
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
      message = parsePerplRequestIds(raw) as TradingMessage
      const logHeartbeat = message.mt === 100 && Date.now() - this.lastHeartbeatDiagnosticAt >= 60_000
      if (message.mt !== 100 || logHeartbeat) this.diagnostic(`PERPL_WS_MESSAGE mt=${message.mt ?? 'unknown'}`)
      const applied = this.state.apply(message)
      if (message.mt === 19) this.diagnostic('PERPL_WS_SNAPSHOT mt=19')
      if (message.mt === 23) this.diagnostic('PERPL_WS_SNAPSHOT mt=23')
      if (message.mt === 26) this.diagnostic('PERPL_WS_SNAPSHOT mt=26')
      if (message.mt === 100) {
        if (logHeartbeat) { this.lastHeartbeatDiagnosticAt = Date.now(); this.diagnostic('PERPL_WS_HEARTBEAT mt=100') }
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
      const pending = message.cid === undefined ? undefined : this.pending.get(message.cid)
      if (pending) {
        this.diagnostic(`PERPL_WS_ORDER_STATUS actionId=${pending.action.id} cid=${message.cid} rq=${pending.rq} code=${message.status?.code ?? 'unknown'} reason=${JSON.stringify(message.status?.error ?? '')}`)
        if (message.status?.code === 0) return // Admission is not a fill; mt:24/reconciliation decides outcome.
        clearTimeout(pending.timer); this.pending.delete(message.cid!)
        pending.resolve({ venueReference: `${pending.accountId}:${pending.rq}`, status: 'FAILED', reason: message.status?.code === 32 ? 'ORDER_REQUEST_ID_TOO_LOW' : `PERPL_ORDER_REJECTED_${message.status?.code ?? 'UNKNOWN'}` })
        return
      }
      if (this.lifecycle !== 'AUTHENTICATING' && this.lifecycle !== 'AUTHENTICATED') { this.diagnostic(`PERPL_WS_UNMATCHED_STATUS cid=${message.cid ?? 'unknown'} code=${message.status?.code ?? 'unknown'}`); return }
      this.diagnostic(`PERPL_WS_AUTH_RESPONSE code=${message.status?.code ?? 'unknown'}`)
      if (message.status?.code !== 0) { this.authenticationFailed = true; this.lifecycle = 'FAILED'; const waiter = this.readyWaiter; this.readyWaiter = undefined; waiter?.reject(new Error('PERPL_WS_AUTH_FAILED')); this.socket?.close(); return }
      this.lifecycle = 'AUTHENTICATED'
      return
    }
    if (message.mt !== 24 || !message.d) return
    for (const order of message.d) { const entry = [...this.pending.entries()].find(([, value]) => value.rq === String(order.rq)); if (!entry) continue; const [sn, pending] = entry; const status = mapPerplOrderStatus(order.st ?? 0); if (status === 'SUBMITTED') continue; clearTimeout(pending.timer); this.pending.delete(sn); pending.resolve({ venueReference: `${pending.accountId}:${pending.rq}:${order.oid ?? pending.rq}`, status: status === 'FAILED' && pending.action.kind === 'DEFEND' ? 'UNKNOWN' : status, reason: order.sr === 32 ? 'ORDER_REQUEST_ID_TOO_LOW' : undefined }) }
  }
  private failPending(status: PerplSubmitStatus) { for (const [sn, pending] of this.pending) { clearTimeout(pending.timer); pending.resolve({ venueReference: `${pending.accountId}:${pending.rq}`, status, reason: 'PERPL_ORDER_TRANSPORT_AMBIGUOUS' }); this.pending.delete(sn) } }
}
