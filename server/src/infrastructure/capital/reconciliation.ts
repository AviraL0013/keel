import { formatMoney, moneyMicros } from '../../../../packages/ausd/src/money.js'

export type BookCapitalRow = {
  bookId: string
  market?: string
  available: string
  reserved: string
  deployed: string
  updatedAt: string
}

/** Ledger buckets and venue balance remain separate; only like-for-like Book amounts are summed. */
export function reconcileBookCapital(rows: BookCapitalRow[], perplFree?: string) {
  let available = 0n
  let reserved = 0n
  let deployed = 0n
  const allocations = rows.map((row) => {
    const values = {
      bookId: row.bookId,
      market: row.market,
      available: formatMoney(moneyMicros(row.available)),
      reserved: formatMoney(moneyMicros(row.reserved)),
      deployed: formatMoney(moneyMicros(row.deployed)),
      updatedAt: row.updatedAt,
    }
    available += moneyMicros(row.available)
    reserved += moneyMicros(row.reserved)
    deployed += moneyMicros(row.deployed)
    return values
  })
  const free = perplFree === undefined ? undefined : moneyMicros(perplFree)
  return {
    available: formatMoney(available),
    reserved: formatMoney(reserved),
    deployed: formatMoney(deployed),
    unreserved: free === undefined ? null : formatMoney(free > available ? free - available : 0n),
    coverage:
      free !== undefined && available > free
        ? { promised: formatMoney(available), perplFree: formatMoney(free), shortfall: formatMoney(available - free) }
        : undefined,
    allocations,
    updatedAt: rows.reduce<string | undefined>(
      (latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest),
      undefined,
    ),
  }
}
