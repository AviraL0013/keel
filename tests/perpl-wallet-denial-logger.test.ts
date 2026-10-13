import { describe, expect, it } from 'vitest'
import { createPerplWalletDenialReporter } from '../server/src/infrastructure/perpl/wallet-denial-diagnostics.js'
import type { WalletHttp451Diagnostic } from '../packages/perpl/src/history.js'

const diagnostic: WalletHttp451Diagnostic = {
  status: 451,
  contentKind: 'html',
  edgeProvider: 'cloudflare',
  redirectOriginSame: true,
  bodyComplete: true,
  bodyReadTimedOut: false,
  legal: true,
  region: true,
  origin: false,
  authentication: false,
  rateLimit: false,
  waf: true,
}

describe('Perpl wallet denial logging', () => {
  it('projects only fixed metadata, never extra fields or arbitrary values', () => {
    const rows: unknown[] = []
    const report = createPerplWalletDenialReporter('account-state', {
      sink: { warn: (row) => rows.push(row) },
      now: () => 1_000,
      lastEmission: new Map(),
    })
    report({
      ...diagnostic,
      contentKind: 'SECRET_CONTENT_TYPE',
      edgeProvider: 'SECRET_PROVIDER',
      body: 'PRIVATE_KEY_SENTINEL',
      token: 'API_TOKEN_SENTINEL',
      wallet: 'WALLET_ADDRESS_SENTINEL',
      headers: { authorization: 'SECRET_HEADER_SENTINEL' },
    } as unknown as WalletHttp451Diagnostic)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'account-state',
      diagnostic: { status: 451, contentKind: 'unknown', edgeProvider: 'unknown', legal: true, region: true },
    })
    expect(JSON.stringify(rows)).not.toMatch(/SECRET_|PRIVATE_KEY_|API_TOKEN_|WALLET_ADDRESS_/)
  })

  it('shares a one-minute limit across recreated reporters without using wallet identifiers', () => {
    let now = 10_000
    const rows: unknown[] = []
    const options = { sink: { warn: (row: unknown) => rows.push(row) }, now: () => now, lastEmission: new Map() }
    createPerplWalletDenialReporter('account-state', options)(diagnostic)
    now += 1
    createPerplWalletDenialReporter('account-state', options)(diagnostic)
    createPerplWalletDenialReporter('account-discovery', options)(diagnostic)
    expect(rows).toHaveLength(2)
    now += 60_000
    createPerplWalletDenialReporter('account-state', options)(diagnostic)
    expect(rows).toHaveLength(3)
    expect([...options.lastEmission.keys()]).toEqual(['account-state', 'account-discovery'])
  })

  it('does not report other statuses and tolerates a failed log sink', () => {
    let calls = 0
    const report = createPerplWalletDenialReporter('runtime-history', {
      sink: {
        warn: () => {
          calls++
          throw new Error('LOG_SINK_FAILED')
        },
      },
      now: () => 1_000,
      lastEmission: new Map(),
    })
    report({ ...diagnostic, status: 401 } as unknown as WalletHttp451Diagnostic)
    expect(calls).toBe(0)
    expect(() => report(diagnostic)).not.toThrow()
    expect(calls).toBe(1)
  })
})
