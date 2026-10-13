import { readFile, writeFile } from 'node:fs/promises'
import type { Action, Book, Decision, NormalizedTelemetry, Position, Reserve } from '../../packages/domain/src/index.js'
import { ExecutionWorker, type ExecutionRepository } from '../../server/src/workers/execution-worker.js'

export type SyntheticLedger = { actions: Action[]; decisions: Decision[]; orderIds: string[] }

/** No provider, URL, credential, or database connection is accepted by this fixture. */
export class SyntheticExecutionFixture {
  ledger: SyntheticLedger = { actions: [], decisions: [], orderIds: [] }
  unavailable = false
  readonly book: Book
  readonly position: Position
  readonly reserve: Reserve
  readonly telemetry: NormalizedTelemetry
  readonly repository: ExecutionRepository

  constructor(private readonly path?: string) {
    const at = Date.now()
    this.book = {
      id: 'synthetic-book',
      userId: 'synthetic-owner',
      market: 'BTC',
      side: 'LONG',
      stance: 'DEFEND',
      liquidationFloor: 6,
      defenseCap: 100,
      timeLimitMs: 3_600_000,
      automationEnabled: true,
      status: 'ACTIVE',
      createdAt: new Date(at - 1000).toISOString(),
      updatedAt: new Date(at).toISOString(),
    }
    this.position = {
      bookId: this.book.id,
      side: 'LONG',
      size: 1,
      entryPrice: 100,
      markPrice: 98,
      liquidationPrice: 94,
      leverage: 6,
      unrealizedPnl: -2,
      margin: 16,
      status: 'OPEN',
      timestamp: at,
    }
    this.reserve = {
      bookId: this.book.id,
      available: 100,
      reserved: 0,
      deployed: 0,
      cap: 100,
      updatedAt: new Date(at).toISOString(),
    }
    this.telemetry = {
      mark: 98,
      oracle: 98,
      bid: 97.9,
      ask: 98.1,
      mid: 98,
      spreadBps: 20,
      fundingRate: 0,
      depthNotional: 10_000,
      volatility: 0.01,
      volume24h: 100,
      openInterest: 100,
      block: 1,
      timestamp: at,
      source: 'replay',
      freshnessMs: 1,
    }
    const check = () => {
      if (this.unavailable) throw Error('SYNTHETIC_DATABASE_CONNECTION_LOST')
    }
    this.repository = {
      getActionByIdempotency: async (key) => {
        check()
        return this.ledger.actions.find((row) => row.idempotencyKey === key) ?? null
      },
      getActiveAction: async (bookId) => {
        check()
        return (
          this.ledger.actions.find(
            (row) => row.bookId === bookId && !['CONFIRMED', 'FAILED', 'CANCELED', 'EXPIRED'].includes(row.status),
          ) ?? null
        )
      },
      saveAction: async (action) => {
        check()
        const index = this.ledger.actions.findIndex((row) => row.id === action.id)
        if (index < 0) this.ledger.actions.push(structuredClone(action))
        else this.ledger.actions[index] = structuredClone(action)
        await this.persist()
      },
      saveDecision: async (decision) => {
        check()
        this.ledger.decisions.push(decision)
        await this.persist()
      },
      addEvent: async () => {
        check()
      },
      getBookContext: async () => {
        check()
        return {
          book: this.book,
          position: this.position,
          reserve: this.reserve,
          telemetry: this.telemetry,
          priorDefenseEfficiency: Infinity,
        }
      },
      updateReserve: async () => {
        check()
      },
      finalize: async (action) => {
        await this.repository.saveAction(action)
        return action
      },
    }
  }
  async persist() {
    if (this.path) await writeFile(this.path, JSON.stringify(this.ledger), { mode: 0o600 })
  }
  async restore() {
    if (!this.path) throw Error('SYNTHETIC_LEDGER_REQUIRED')
    this.ledger = JSON.parse(await readFile(this.path, 'utf8')) as SyntheticLedger
  }
  worker(reconcile: (action: Action) => Promise<Action> = async (action) => ({ ...action, status: 'CONFIRMED' })) {
    return new ExecutionWorker(
      this.repository,
      {
        submit: async (action, verify) => {
          await verify?.()
          this.ledger.orderIds.push(action.id)
          await this.persist()
          return { venueReference: '642:45', status: 'SUBMITTED' }
        },
        reconcile,
      },
      undefined,
      Date.now,
      () => false,
    )
  }
}
