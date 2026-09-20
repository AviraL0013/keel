export type LedgerEntryType = 'RESERVE_CREATED' | 'RESERVE_RESERVED' | 'RESERVE_DEPLOYED' | 'RESERVE_RELEASED' | 'RESERVE_RECONCILED'
export type LedgerEntry = { id: string; bookId: string; type: LedgerEntryType; amount: number; actionId?: string; decisionId?: string; externalReference?: string; createdAt: string }
export class ReserveLedger {
  private readonly entries = new Map<string, LedgerEntry[]>()
  append(entry: Omit<LedgerEntry, 'id' | 'createdAt'>) {
    if (!Number.isFinite(entry.amount) || entry.amount < 0) throw new Error('RESERVE_AMOUNT_INVALID')
    const current = this.entries.get(entry.bookId) ?? []; const available = this.net(entry.bookId, ['RESERVE_CREATED','RESERVE_RECONCILED']) - this.net(entry.bookId, ['RESERVE_RESERVED','RESERVE_DEPLOYED','RESERVE_RELEASED'])
    const cap = current.filter(item => item.type === 'RESERVE_CREATED').reduce((sum, item) => sum + item.amount, 0) + (entry.type === 'RESERVE_CREATED' ? entry.amount : 0)
    const reserved = this.net(entry.bookId, ['RESERVE_RESERVED']) - this.net(entry.bookId, ['RESERVE_RELEASED'])
    const deployed = this.net(entry.bookId, ['RESERVE_DEPLOYED']) - this.net(entry.bookId, ['RESERVE_RECONCILED'])
    if (entry.type === 'RESERVE_RESERVED' && entry.amount > Math.max(0, available)) throw new Error('RESERVE_AVAILABLE_EXCEEDED')
    if (entry.type === 'RESERVE_DEPLOYED' && deployed + entry.amount > cap) throw new Error('RESERVE_CAP_EXCEEDED')
    if (entry.type === 'RESERVE_DEPLOYED' && entry.amount > Math.max(0, reserved + available)) throw new Error('RESERVE_AVAILABLE_EXCEEDED')
    if (entry.type === 'RESERVE_DEPLOYED' && deployed + entry.amount > cap) throw new Error('RESERVE_CAP_EXCEEDED')
    if (entry.type === 'RESERVE_RELEASED' && entry.amount > reserved) throw new Error('RESERVE_RESERVED_EXCEEDED')
    const next = { ...entry, id: crypto.randomUUID(), createdAt: new Date().toISOString() }; this.entries.set(entry.bookId, [...current, next]); return next
  }
  list(bookId: string) { return this.entries.get(bookId) ?? [] }
  total(bookId: string, type: LedgerEntryType) { return this.list(bookId).filter(entry => entry.type === type).reduce((sum, entry) => sum + entry.amount, 0) }
  balance(bookId: string) { const created=this.total(bookId,'RESERVE_CREATED') + this.total(bookId,'RESERVE_RECONCILED'); const reserved=this.total(bookId,'RESERVE_RESERVED')-this.total(bookId,'RESERVE_RELEASED'); const deployed=this.total(bookId,'RESERVE_DEPLOYED')-this.total(bookId,'RESERVE_RECONCILED'); return { total: created, reserved, deployed, available: created-reserved-deployed } }
  private net(bookId: string, types: LedgerEntryType[]) { return types.reduce((sum,type)=>sum+this.total(bookId,type),0) }
}



