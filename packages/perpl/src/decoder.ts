// Wire shapes follow bundled Perpl types.md and websocket.md.
export type Stamp = { b?: number; t?: number; tx?: number; txid?: string; l?: number }
export type WireAccount = { id: number; in: number; fr: boolean; fw: boolean; ft: number; lfr: number; b: string; lb: string }
export type WirePosition = { acc: number; mkt: number; pid: number; st: number; sd: number; c: string; ep: number; s: number; lv: number; at: Stamp; efs: number; xfs: number; fee: string }
export type WireOrder = { acc: number; mkt: number; oid: number; rq: number; st: number; sr: number; t: number; os: number; fs: number; at: Stamp; r?: boolean }
export type WireFill = { acc: number; mkt: number; oid: number; t: number; p?: number; s: number; at: Stamp; f: string }
export type PerplMessage = Record<string, unknown> & { mt: number; sn?: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function requireFields(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!object(value) || fields.some(key => !integer(value[key]))) throw new Error('PERPL_MALFORMED_FRAME')
}
export function decodeTradingMessage(value: unknown) {
  if (!object(value) || !integer(value.mt)) throw new Error('PERPL_MALFORMED_FRAME')
  const message = value as PerplMessage
  const kind = message.mt === 19 ? 'wallet' : message.mt === 21 ? 'account' : message.mt === 23 || message.mt === 24 ? 'orders' : message.mt === 26 || message.mt === 27 ? 'positions' : message.mt === 25 ? 'fills' : 'unknown'
  return { kind, payload: message, sequence: message.sn }
}
const stamp = (value: {at: Stamp}) => [value.at.b ?? 0, value.at.tx ?? 0, value.at.l ?? 0, value.at.t ?? 0]
function older(a: {at: Stamp}, b: {at: Stamp}) { const x=stamp(a), y=stamp(b); for(let i=0;i<x.length;i++) { if(x[i] !== y[i]) return x[i]<y[i] } return false }
export class PerplStateStore {
  private accounts = new Map<number, WireAccount>()
  private positions = new Map<number, WirePosition>()
  private orders = new Map<number, WireOrder>()
  private fills = new Map<string, WireFill>()
  private wallet?: { addr: string; as: WireAccount[] }
  private heartbeatSequence?: number
  private snapshots = new Set<number>()
  private connected = false
  private lastHeartbeatAt = 0
  reset() { this.accounts.clear(); this.positions.clear(); this.orders.clear(); this.fills.clear(); this.snapshots.clear(); this.wallet=undefined; this.heartbeatSequence=undefined; this.connected=false; this.lastHeartbeatAt=0 }
  disconnect() { this.connected=false }
  ready(now=Date.now(), maximumAge=10000) { return this.connected && [19,23,26].every(type=>this.snapshots.has(type)) && now-this.lastHeartbeatAt<=maximumAge }
  apply(input: unknown, receivedAt=Date.now()) {
    const {payload: message}=decodeTradingMessage(input)
    if(message.mt===19) {
      if(typeof message.addr!=='string' || !Array.isArray(message.as) || !integer(message.sn)) throw new Error('PERPL_WALLET_SNAPSHOT_INVALID')
      this.reset(); this.wallet={addr:message.addr,as:[]}; this.heartbeatSequence=message.sn; this.connected=true; this.lastHeartbeatAt=receivedAt
      for(const account of message.as) this.account(account)
      this.snapshots.add(19)
    } else if(message.mt===21) this.account(message)
    else if(message.mt===100) {
      if(!integer(message.sn) || this.heartbeatSequence===undefined || message.sn!==this.heartbeatSequence+1) { this.connected=false; return {accepted:false,reason:'SEQUENCE_GAP' as const} }
      this.heartbeatSequence=message.sn; this.lastHeartbeatAt=receivedAt
    } else if([23,24,25,26,27].includes(message.mt)) {
      if(!this.wallet || !Array.isArray(message.d)) throw new Error('PERPL_SNAPSHOT_REQUIRED')
      if(message.mt===23) this.orders.clear()
      if(message.mt===26) this.positions.clear()
      for(const raw of message.d) {
        requireFields(raw,['acc','mkt']); if(!object(raw.at)) throw new Error('PERPL_TIMESTAMP_REQUIRED')
        if(message.mt===23 || message.mt===24) { requireFields(raw,['oid','rq','st','t','os','fs']); const value=raw as unknown as WireOrder; const previous=this.orders.get(value.oid); if(!previous || !older(value,previous)) this.orders.set(value.oid,value) }
        else if(message.mt===26 || message.mt===27) { requireFields(raw,['pid','st','sd','ep','s','lv']); if(typeof raw.c!=='string' || !/^\d+$/.test(raw.c)) throw new Error('PERPL_COLLATERAL_INVALID'); const value=raw as unknown as WirePosition; const previous=this.positions.get(value.pid); if(!previous || !older(value,previous)) this.positions.set(value.pid,value) }
        else { requireFields(raw,['oid','s','t']); const value=raw as unknown as WireFill; const key=JSON.stringify([value.acc,value.oid,value.at]); this.fills.set(key,value) }
      }
      if(message.mt===23 || message.mt===26) this.snapshots.add(message.mt)
    }
    return {accepted:true,state:this.snapshot()}
  }
  private account(raw:unknown) { requireFields(raw,['id','in','lfr','ft']); if(typeof raw.b!=='string' || typeof raw.lb!=='string' || !/^\d+$/.test(raw.b) || !/^\d+$/.test(raw.lb) || typeof raw.fr!=='boolean' || typeof raw.fw!=='boolean') throw new Error('PERPL_ACCOUNT_INVALID'); this.accounts.set(raw.id as number,raw as unknown as WireAccount) }
  snapshot() { return {wallet:this.wallet ? {...this.wallet,as:[...this.accounts.values()]} : undefined,accounts:[...this.accounts.values()],positions:[...this.positions.values()],orders:[...this.orders.values()],fills:[...this.fills.values()]} }
  requestIdBaseline(accountId?:number) { const account=accountId===undefined ? [...this.accounts.values()][0] : this.accounts.get(accountId); if(!account) throw new Error('PERPL_ACCOUNT_SNAPSHOT_REQUIRED'); return account.lfr }
}
