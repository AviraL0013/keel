import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { publicAusdSupply } from '../server/src/infrastructure/agora/metrics.js'

describe('optional public Agora supply', () => {
  it('preserves the six-decimal string exactly and does not claim it belongs to the user', () => {
    expect(publicAusdSupply({ totalSupply: '253317445.813025', partial: false })).toMatchObject({
      status: 'AVAILABLE',
      supply: '253317445.813025',
      scope: 'GLOBAL_AUSD',
    })
  })

  it('does not show partial or malformed metrics as a live supply', () => {
    expect(publicAusdSupply({ totalSupply: '1.000000', partial: true })).toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'AGORA_METRICS_PARTIAL',
    })
    expect(publicAusdSupply({ totalSupply: 1.1, partial: false })).toMatchObject({ status: 'UNAVAILABLE' })
    expect(publicAusdSupply({ totalSupply: '1.0000001', partial: false })).toMatchObject({ status: 'UNAVAILABLE' })
  })

  it('does not import Agora into the deterministic risk engine', async () => {
    for (const file of [
      'packages/risk-engine/src/index.ts',
      'packages/risk-engine/src/policy.ts',
      'packages/risk-engine/src/sizing.ts',
    ]) {
      expect(await readFile(file, 'utf8')).not.toMatch(/agora/i)
    }
  })
})
