import type { DerivedEvent } from './aggregate.js'

export type RollupGrain = 'hour' | 'day'
export interface RollupBucket {
  grain: RollupGrain
  bucketStart: string
  marketId: number
  feesMicros: bigint
  revenueMicros: bigint
  depositsMicros: bigint
  withdrawalsMicros: bigint
  liquidationCount: bigint
  liquidationNotionalMicros: bigint
  longOpens: bigint
  shortOpens: bigint
}
export interface RollupActor {
  grain: RollupGrain
  bucketStart: string
  accountId: string
  ownerAddress: string | null
}

const emptyBucket = (grain: RollupGrain, bucketStart: string, marketId: number): RollupBucket => ({
  grain,
  bucketStart,
  marketId,
  feesMicros: 0n,
  revenueMicros: 0n,
  depositsMicros: 0n,
  withdrawalsMicros: 0n,
  liquidationCount: 0n,
  liquidationNotionalMicros: 0n,
  longOpens: 0n,
  shortOpens: 0n,
})

/** Aggregates decoded events in memory; transaction and event payloads never leave this scope. */
export class RollupAccumulator {
  private readonly buckets = new Map<string, RollupBucket>()
  private readonly actors = new Map<string, RollupActor>()
  private readonly owners = new Map<string, string>()

  add(event: DerivedEvent | null, occurredAt: Date): void {
    if (!event) return
    if (!Number.isFinite(occurredAt.getTime())) throw new Error('ROLLUP_TIME_INVALID')
    if (event.kind === 'account') {
      this.owners.set(event.accountId, event.address)
      return
    }
    const hour = new Date(Math.floor(occurredAt.getTime() / 3_600_000) * 3_600_000).toISOString()
    const day = new Date(Math.floor(occurredAt.getTime() / 86_400_000) * 86_400_000).toISOString()
    for (const [grain, start] of [
      ['hour', hour],
      ['day', day],
    ] as const) {
      const bucket = (marketId: number) => {
        const key = `${grain}:${start}:${marketId}`
        let value = this.buckets.get(key)
        if (!value) {
          value = emptyBucket(grain, start, marketId)
          this.buckets.set(key, value)
        }
        return value
      }
      const global = bucket(-1)
      const actor = (accountId: string) => {
        const key = `${grain}:${start}:${accountId}`
        if (!this.actors.has(key)) this.actors.set(key, { grain, bucketStart: start, accountId, ownerAddress: null })
      }
      if (event.kind === 'fill') {
        global.feesMicros += event.feeMicros
        bucket(event.marketId).feesMicros += event.feeMicros
        actor(event.accountId)
      } else if (event.kind === 'taker_fee') {
        global.feesMicros += event.feeMicros
      } else if (event.kind === 'flow') {
        if (event.direction === 'deposit') global.depositsMicros += event.amountMicros
        else global.withdrawalsMicros += event.amountMicros
      } else if (event.kind === 'liquidation') {
        global.liquidationCount++
        global.liquidationNotionalMicros += event.notionalMicros
        const market = bucket(event.marketId)
        market.liquidationCount++
        market.liquidationNotionalMicros += event.notionalMicros
      } else if (event.kind === 'position') {
        actor(event.accountId)
        if (event.protocolFeeMicros !== null) {
          global.revenueMicros += event.protocolFeeMicros
          bucket(event.marketId).revenueMicros += event.protocolFeeMicros
        }
        if (event.action === 'open' || event.action === 'invert') {
          const market = bucket(event.marketId)
          if (event.side === 'long') {
            global.longOpens++
            market.longOpens++
          } else {
            global.shortOpens++
            market.shortOpens++
          }
        }
      }
    }
  }

  result(): { buckets: RollupBucket[]; actors: RollupActor[] } {
    return {
      buckets: [...this.buckets.values()],
      actors: [...this.actors.values()].map((actor) => ({
        ...actor,
        ownerAddress: this.owners.get(actor.accountId) ?? null,
      })),
    }
  }
}

/** Exact continuity check for half-open block ranges. */
export function completeRange(
  coverage: Array<{ fromBlock: bigint; toBlock: bigint }>,
  fromBlock: bigint,
  toBlock: bigint,
): boolean {
  if (fromBlock >= toBlock) return false
  let cursor = fromBlock
  for (const range of [...coverage].sort((a, b) =>
    a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1 : 0,
  )) {
    if (range.toBlock <= cursor) continue
    if (range.fromBlock > cursor) return false
    cursor = range.toBlock
    if (cursor >= toBlock) return true
  }
  return false
}

/** Highest missing slice, so backfill moves newest-first. */
export function newestGap(
  coverage: Array<{ fromBlock: bigint; toBlock: bigint }>,
  fromBlock: bigint,
  toBlock: bigint,
  maxBlocks: bigint,
): { fromBlock: bigint; toBlock: bigint } | null {
  if (fromBlock >= toBlock || maxBlocks < 1n) return null
  let cursor = toBlock
  for (const range of [...coverage].sort((a, b) => (a.toBlock > b.toBlock ? -1 : a.toBlock < b.toBlock ? 1 : 0))) {
    if (range.fromBlock >= cursor) continue
    if (range.toBlock < cursor) {
      const lower = range.toBlock > fromBlock ? range.toBlock : fromBlock
      return { fromBlock: cursor - lower > maxBlocks ? cursor - maxBlocks : lower, toBlock: cursor }
    }
    cursor = range.fromBlock
    if (cursor <= fromBlock) return null
  }
  return { fromBlock: cursor - fromBlock > maxBlocks ? cursor - maxBlocks : fromBlock, toBlock: cursor }
}
