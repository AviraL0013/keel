import { expect, it, vi } from 'vitest'
import { runReliabilityChaosSuite, verifiedSyntheticTempDirectory } from '../scripts/reliability/chaos.js'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ExecutionWorker } from '../server/src/workers/execution-worker.js'
import { PerplTradingClient } from '../packages/perpl/src/trading.js'
import { subscribePerplReliability } from '../packages/perpl/src/reliability-events.js'
import type { Action } from '../packages/domain/src/index.js'

it('permits recursive cleanup only for an immediate temporary child with the actual synthetic prefix', () => {
  const base = tmpdir()
  const valid = join(base, 'eyeler-synthetic-chaos-fixture')
  expect(verifiedSyntheticTempDirectory(valid)).toBe(resolve(valid))
  for (const target of [
    base,
    join(base, '..', 'eyeler-synthetic-chaos-fixture'),
    join(valid, 'eyeler-synthetic-chaos-nested'),
    join(base, 'eyeler-chaos-wrong-prefix'),
  ])
    expect(() => verifiedSyntheticTempDirectory(target)).toThrow('SYNTHETIC_TEMP_PATH_INVALID')
})

it('injects seven isolated failures and records measured application safety and recovery', async () => {
  const transportEvents: unknown[] = []
  const unsubscribe = subscribePerplReliability((event) => transportEvents.push(event))
  let results: Awaited<ReturnType<typeof runReliabilityChaosSuite>>
  try {
    results = await runReliabilityChaosSuite()
  } finally {
    unsubscribe()
  }
  expect(transportEvents).toHaveLength(0)
  expect(results.map((result) => result.scenario)).toEqual([
    'process-kill-mid-action',
    'websocket-disconnect',
    'stale-market-data',
    'rpc-timeout',
    'database-connection-loss',
    'competing-lock-instances',
    'delayed-partial-fills',
  ])
  for (const result of results) {
    expect(result.status, `${result.scenario}: ${result.summary}`).toBe('passed')
    expect(Date.parse(result.at)).toBeGreaterThan(0)
    expect(Number.isFinite(result.recoveryMs)).toBe(true)
    expect(result.recoveryMs).toBeGreaterThanOrEqual(0)
    expect(result.invariants).toEqual({
      noDuplicateOrders: true,
      noUnknownResubmission: true,
      noPartialResubmission: true,
      failClosed: true,
    })
    expect(result.summary).toContain('Synthetic')
  }
  expect(JSON.stringify(results)).not.toMatch(/0x[0-9a-f]{40}|private_key|api[_-]?token/i)
}, 30_000)

it('reports unavailable proof without exposing private exception details', async () => {
  const marker = 'SYNTHETIC_PRIVATE_DIAGNOSTIC_NEVER_PUBLISH'
  const broken = vi.spyOn(PerplTradingClient.prototype, 'submitOpening').mockRejectedValue(Error(marker))
  try {
    const results = await runReliabilityChaosSuite()
    expect(results.find((result) => result.scenario === 'websocket-disconnect')?.status).toBe('unavailable')
    expect(JSON.stringify(results)).not.toContain(marker)
  } finally {
    broken.mockRestore()
  }
}, 30_000)

it('reports failed invariants when the real execution guard is bypassed', async () => {
  const broken = vi.spyOn(ExecutionWorker.prototype, 'execute').mockImplementation(
    async () =>
      ({
        id: 'synthetic-unsafe-replacement',
        status: 'CONFIRMED',
      }) as Action,
  )
  try {
    const results = await runReliabilityChaosSuite()
    expect(results.filter((result) => result.status === 'passed')).toHaveLength(0)
    expect(results.some((result) => result.status === 'failed' && !result.invariants.failClosed)).toBe(true)
    expect(
      results.some((result) => !result.invariants.noUnknownResubmission && !result.invariants.noPartialResubmission),
    ).toBe(true)
  } finally {
    broken.mockRestore()
  }
}, 30_000)
