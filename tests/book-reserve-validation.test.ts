import { expect, it } from 'vitest'
import { BooksApplication } from '../server/src/application/books.js'
import type { Book, BookRepository } from '../server/src/application/ports.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import { ReserveLedger } from '../packages/chain/src/ledger.js'

function input(overrides: Partial<{ reserveAvailable: number; defenseCap: number }> = {}) {
  return {
    market: 'BTC-PERP', marketId: 1, venueAccountId: 642, venuePositionId: 77,
    side: 'LONG' as const, stance: 'DEFEND' as const, liquidationFloor: 6,
    defenseCap: overrides.defenseCap ?? 5, timeLimitMs: 24 * 60 * 60 * 1000,
    automationEnabled: false, status: 'PAUSED' as const,
    reserveAvailable: overrides.reserveAvailable ?? 10,
  }
}

it('allows reserve 10 with single-defense cap 5', async () => {
  const store = new MemoryStore()
  const book = await store.createBook('user', input())
  expect(book.defenseCap).toBe(5)
  expect((await store.getReserve('user', book.id))?.cap).toBe(10)
})

it('allows equal reserve and defense cap', async () => {
  const store = new MemoryStore()
  await expect(store.createBook('user', input({ reserveAvailable: 5, defenseCap: 5 }))).resolves.toBeDefined()
})

it.each([
  ['defense cap above reserve', { reserveAvailable: 5, defenseCap: 10 }],
  ['zero reserve and cap', { reserveAvailable: 0, defenseCap: 0 }],
  ['negative reserve', { reserveAvailable: -1, defenseCap: 5 }],
  ['negative defense cap', { reserveAvailable: 5, defenseCap: -1 }],
] as const)('rejects %s', async (_label, values) => {
  const store = new MemoryStore()
  await expect(store.createBook('user', input(values))).rejects.toThrow()
})

it('rejects reserve above actual available capital in application layer', async () => {
  const repository = { createBook: async (_userId: string, _input: Parameters<BookRepository['createBook']>[1]) => ({}) as Book } as unknown as BookRepository
  const venue = {
    loadBookSetup: async () => ({
      market: 'BTC-PERP',
      reserveAvailable: 5,
      position: { side: 'LONG' as const, size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 90, leverage: 5, unrealizedPnl: 0, margin: 20, status: 'OPEN' as const },
      telemetry: { mark: 100, oracle: 100, bid: 99.9, ask: 100.1, mid: 100, spreadBps: 20, fundingRate: 0, depthNotional: 10000, volatility: 0.01, volume24h: 0, openInterest: 0, block: 1, timestamp: Date.now(), source: 'replay' as const },
    }),
  }
  const application = new BooksApplication(repository, venue)
  await expect(application.create('user', input({ reserveAvailable: 10, defenseCap: 5 }))).rejects.toThrow('Reserve exceeds available capital.')
})

it('creates Book with reserve 10 and defense cap 5 when capital is available', async () => {
  let captured: Parameters<BookRepository['createBook']>[1] | undefined
  const repository = { createBook: async (_userId: string, value: Parameters<BookRepository['createBook']>[1]) => { captured = value; return {} as Book } } as unknown as BookRepository
  const venue = {
    loadBookSetup: async () => ({
      market: 'BTC-PERP',
      reserveAvailable: 99.457410,
      position: { side: 'LONG' as const, size: 1, entryPrice: 100, markPrice: 100, liquidationPrice: 90, leverage: 5, unrealizedPnl: 0, margin: 20, status: 'OPEN' as const },
      telemetry: { mark: 100, oracle: 100, bid: 99.9, ask: 100.1, mid: 100, spreadBps: 20, fundingRate: 0, depthNotional: 10000, volatility: 0.01, volume24h: 0, openInterest: 0, block: 1, timestamp: Date.now(), source: 'replay' as const },
    }),
  }
  const application = new BooksApplication(repository, venue)
  await expect(application.create('user', input({ reserveAvailable: 10, defenseCap: 5 }))).resolves.toBeDefined()
  expect(captured?.reserveAvailable).toBe(10)
  expect(captured?.defenseCap).toBe(5)
})

it('prevents cumulative defense spend from exceeding total reserve', () => {
  const ledger = new ReserveLedger()
  ledger.append({ bookId: 'book', type: 'RESERVE_CREATED', amount: 10 })
  ledger.append({ bookId: 'book', type: 'RESERVE_DEPLOYED', amount: 5 })
  ledger.append({ bookId: 'book', type: 'RESERVE_DEPLOYED', amount: 5 })
  expect(() => ledger.append({ bookId: 'book', type: 'RESERVE_DEPLOYED', amount: 1 })).toThrow('RESERVE_CAP_EXCEEDED')
})
