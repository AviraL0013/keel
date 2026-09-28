import { formatMoney, moneyMicros } from '../../ausd/src/money.js'

export type LedgerEntryType =
  'RESERVE_CREATED' | 'RESERVE_RESERVED' | 'RESERVE_DEPLOYED' | 'RESERVE_RELEASED' | 'RESERVE_RECONCILED'

export type LedgerEntry = {
  id: string
  bookId: string
  type: LedgerEntryType
  amount: number
  actionId?: string
  decisionId?: string
  externalReference?: string
  createdAt: string
}

export class ReserveLedger {
  private readonly entries = new Map<string, LedgerEntry[]>()

  append(entry: Omit<LedgerEntry, 'id' | 'createdAt'>) {
    let amount: bigint
    try {
      amount = moneyMicros(entry.amount)
    } catch {
      throw new Error('RESERVE_AMOUNT_INVALID')
    }
    const current = this.entries.get(entry.bookId) ?? []
    const created = this.netMicros(entry.bookId, ['RESERVE_CREATED'])
    const reserved =
      this.netMicros(entry.bookId, ['RESERVE_RESERVED']) - this.netMicros(entry.bookId, ['RESERVE_RELEASED'])
    const deployed =
      this.netMicros(entry.bookId, ['RESERVE_DEPLOYED']) - this.netMicros(entry.bookId, ['RESERVE_RECONCILED'])
    const available = created - reserved - deployed
    const cap = created + (entry.type === 'RESERVE_CREATED' ? amount : 0n)

    if (entry.type === 'RESERVE_RESERVED' && amount > available) throw new Error('RESERVE_AVAILABLE_EXCEEDED')
    if (entry.type === 'RESERVE_DEPLOYED' && deployed + amount > cap) throw new Error('RESERVE_CAP_EXCEEDED')
    if (entry.type === 'RESERVE_DEPLOYED' && amount > available) throw new Error('RESERVE_AVAILABLE_EXCEEDED')
    if (entry.type === 'RESERVE_RELEASED' && amount > reserved) throw new Error('RESERVE_RESERVED_EXCEEDED')
    if (entry.type === 'RESERVE_RECONCILED' && amount > deployed) throw new Error('RESERVE_DEPLOYED_EXCEEDED')

    const next = { ...entry, id: crypto.randomUUID(), createdAt: new Date().toISOString() }
    this.entries.set(entry.bookId, [...current, next])
    return next
  }

  list(bookId: string) {
    return this.entries.get(bookId) ?? []
  }

  total(bookId: string, type: LedgerEntryType) {
    return Number(formatMoney(this.netMicros(bookId, [type])))
  }

  balanceExact(bookId: string) {
    const total = this.netMicros(bookId, ['RESERVE_CREATED'])
    const reserved = this.netMicros(bookId, ['RESERVE_RESERVED']) - this.netMicros(bookId, ['RESERVE_RELEASED'])
    const deployed = this.netMicros(bookId, ['RESERVE_DEPLOYED']) - this.netMicros(bookId, ['RESERVE_RECONCILED'])
    return {
      total: formatMoney(total),
      reserved: formatMoney(reserved),
      deployed: formatMoney(deployed),
      available: formatMoney(total - reserved - deployed),
    }
  }

  balance(bookId: string) {
    const exact = this.balanceExact(bookId)
    return {
      total: Number(exact.total),
      reserved: Number(exact.reserved),
      deployed: Number(exact.deployed),
      available: Number(exact.available),
    }
  }

  private netMicros(bookId: string, types: LedgerEntryType[]) {
    return this.list(bookId)
      .filter((entry) => types.includes(entry.type))
      .reduce((sum, entry) => sum + moneyMicros(entry.amount), 0n)
  }
}
