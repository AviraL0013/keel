import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeExchangeLog, type ChainLog } from '../packages/analytics/src/decoder.js'

const sample = JSON.parse(readFileSync('packages/analytics/fixtures/mainnet-logs.json', 'utf8')) as {
  chainId: number
  exchange: string
  logs: ChainLog[]
}

describe('Perpl mainnet Exchange log decoder', () => {
  it('decodes recorded public mainnet logs with real SDK ABI', () => {
    expect(sample.chainId).toBe(143)
    expect(sample.logs.length).toBeGreaterThan(0)
    const decoded = sample.logs.map(decodeExchangeLog)
    expect(decoded.every(Boolean)).toBe(true)
    expect(decoded.map((event) => event?.eventName)).toContain('MakerOrderFilledV2')
    for (const event of decoded) {
      expect(event?.block).toBeGreaterThan(0n)
      expect(event?.txHash).toMatch(/^0x[0-9a-f]{64}$/)
      expect(event?.logIndex).toBeGreaterThanOrEqual(0)
    }
  })

  it('rejects a changed contract address and removed log', () => {
    expect(decodeExchangeLog({ ...sample.logs[0], address: '0x0000000000000000000000000000000000000001' })).toBeNull()
    expect(decodeExchangeLog({ ...sample.logs[0], removed: true })).toBeNull()
  })

  it('halts on malformed recognized financial events instead of losing evidence', () => {
    expect(() => decodeExchangeLog({ ...sample.logs[0], data: '0x' })).toThrow('ANALYTICS_RECOGNIZED_LOG_INVALID')
    expect(decodeExchangeLog({ ...sample.logs[0], topics: [`0x${'f'.repeat(64)}`] })).toBeNull()
  })
})
