import { describe, expect, it, vi } from 'vitest'
import { runAutonomous, validateConfig } from '../scripts/run/autonomous-run.mjs'

const config = {
  apiUrl: 'https://testnet-api.example/',
  chainId: 10143,
  perplRestUrl: 'https://testnet-rest.perpl.xyz',
  perplWsUrl: 'wss://testnet-ws.perpl.xyz',
  market: 'ETH',
  marketId: 32,
  positionId: 123,
  reserve: 5,
  cap: 2,
  liquidationFloorOffset: 0.2,
  runMinutes: 60,
}

function fakeApi(
  options: {
    unknown?: boolean
    partial?: boolean
    unauthorized?: boolean
    autoCapBreach?: boolean
    unreadyAfterArm?: boolean
    sandbox?: boolean
  } = {},
) {
  let time = Date.parse('2026-10-02T00:00:00.000Z')
  let armed = false
  const actions: Array<Record<string, unknown>> = []
  const posts: string[] = []
  const events: unknown[] = []
  const persist = vi.fn(async () => undefined)
  const report = vi.fn(async () => undefined)
  const wallet = { address: '0x0000000000000000000000000000000000000001', signMessage: vi.fn(async () => '0xfake') }
  const fetch = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    if (method !== 'GET') posts.push(`${method} ${path}`)
    if (options.unauthorized) return new Response('{}', { status: 403 })
    let data: unknown
    if (path === '/health' || path === '/') data = { environment: options.sandbox ? 'test' : 'testnet' }
    else if (path === '/ready' && options.unreadyAfterArm && armed) return new Response('{}', { status: 503 })
    else if (path === '/ready')
      data = { ready: true, venueReady: true, lockOwned: true, lastTickAgeMs: 1000, executionDisabled: false }
    else if (path === '/auth/challenge') data = { nonce: 'nonce', message: 'challenge' }
    else if (path === '/auth/verify') data = { token: 'fake-session' }
    else if (path === '/connections/perpl/positions')
      data = {
        positions: [
          {
            positionId: 123,
            marketId: 32,
            market: 'ETH',
            accountId: 642,
            position: { status: 'OPEN', side: 'LONG' },
            telemetry: { liquidationDistance: 3 },
            bookCreation: { allowed: true },
          },
        ],
      }
    else if (path === '/capital') data = { perplAvailable: { amount: '10' } }
    else if (path === '/books' && method === 'GET') data = []
    else if (path === '/books' && method === 'POST') data = { id: 'book-1' }
    else if (path === '/books/book-1/actions' && method === 'GET') data = actions
    else if (path === '/books/book-1/actions' && method === 'POST') {
      const kind = JSON.parse(String(init?.body)).kind as string
      const action = {
        id: `${kind}-${actions.length}`,
        kind,
        status: options.unknown ? 'UNKNOWN' : options.partial ? 'PARTIAL' : 'CONFIRMED',
        amount: 1,
        submittedAt: new Date(time).toISOString(),
      }
      actions.unshift(action)
      data = action
    } else if (path === '/books/book-1/close' && method === 'POST') {
      const action = {
        id: 'exit-1',
        kind: 'EXIT',
        status: 'CONFIRMED',
        amount: 0,
        submittedAt: new Date(time).toISOString(),
      }
      actions.unshift(action)
      data = action
    } else if (path === '/books/book-1' && method === 'GET')
      data = { id: 'book-1', status: 'ACTIVE', automationEnabled: armed, venuePositionId: 123 }
    else if (path === '/books/book-1/position') data = { status: 'OPEN' }
    else if (path === '/books/book-1/reserve') data = { available: 5, reserved: 0, deployed: 0, cap: 2 }
    else if (path === '/books/book-1/arm') {
      armed = true
      if (options.autoCapBreach)
        actions.unshift({
          id: 'auto-defend',
          kind: 'DEFEND',
          status: 'CONFIRMED',
          amount: 3,
          submittedAt: new Date(time).toISOString(),
        })
      data = { id: 'book-1', automationEnabled: true }
    } else if (path === '/books/book-1/pause') {
      armed = false
      data = { id: 'book-1', automationEnabled: false }
    } else throw new Error(`UNEXPECTED_FAKE_ROUTE_${method}_${path}`)
    return new Response(JSON.stringify(data), { status: 200 })
  })
  return {
    fetch,
    posts,
    actions,
    events,
    persist,
    report,
    wallet,
    now: () => time,
    sleep: async (ms: number) => {
      time += ms
    },
    record: async (event: unknown) => {
      events.push(event)
    },
  }
}

describe('autonomous run harness safety', () => {
  it('runs the bounded flow against a fake testnet API without retrying an action', async () => {
    const api = fakeApi()
    const result = await runAutonomous(config, api)
    expect(result.phase).toBe('DONE')
    expect(api.posts.filter((item: string) => item === 'POST /books/book-1/actions')).toHaveLength(2)
    expect(api.posts.filter((item: string) => item === 'POST /books/book-1/close')).toHaveLength(1)
    expect(api.posts).toContain('POST /books/book-1/pause')
    expect(api.report).toHaveBeenCalledOnce()
    expect(api.events.length).toBeGreaterThan(1)
  })

  it('stops on UNKNOWN without a second submission', async () => {
    const api = fakeApi({ unknown: true })
    await expect(runAutonomous(config, api)).rejects.toThrow('UNRESOLVED_ACTION_STOP')
    expect(api.posts.filter((item: string) => item === 'POST /books/book-1/actions')).toHaveLength(1)
  })

  it('stops on PARTIAL without a second submission', async () => {
    const api = fakeApi({ partial: true })
    await expect(runAutonomous(config, api)).rejects.toThrow('UNRESOLVED_ACTION_STOP')
    expect(api.posts.filter((item: string) => item === 'POST /books/book-1/actions')).toHaveLength(1)
  })

  it('stops on a 403 and never creates a Book', async () => {
    const api = fakeApi({ unauthorized: true })
    await expect(runAutonomous(config, api)).rejects.toThrow('ACCESS_DENIED_403')
    expect(api.posts).not.toContain('POST /books')
  })

  it('stops on an automated defense above the hard cap', async () => {
    const api = fakeApi({ autoCapBreach: true })
    await expect(runAutonomous(config, api)).rejects.toThrow('DEFENSE_CAP_BREACH')
    expect(api.posts).not.toContain('POST /books/book-1/close')
  })

  it('stops after two minutes of lost readiness', async () => {
    const api = fakeApi({ unreadyAfterArm: true })
    await expect(runAutonomous(config, api)).rejects.toThrow('READY_UNAVAILABLE_OVER_TWO_MINUTES')
  })

  it('runs dry mode only against a test environment', async () => {
    const api = fakeApi({ sandbox: true })
    expect((await runAutonomous(config, { ...api, dryRun: true })).phase).toBe('DONE')
  })

  it('runs an optional midpoint restart once and resumes readiness checks', async () => {
    const api = fakeApi()
    const restart = vi.fn(async () => undefined)
    await runAutonomous({ ...config, restartCommand: ['fake-restart'] }, { ...api, restart })
    expect(restart).toHaveBeenCalledTimes(1)
    expect(restart).toHaveBeenCalledWith(['fake-restart'])
  })

  it('resumes after confirmed DEFEND without submitting it again', async () => {
    const api = fakeApi()
    const state = {
      runId: 'resume-1',
      phase: 'MANUAL_REDUCE',
      startedAt: new Date(api.now()).toISOString(),
      bookId: 'book-1',
      actionIntents: { DEFEND: { at: api.now(), status: 'CONFIRMED', actionId: 'DEFEND-0' } },
    }
    await runAutonomous(config, { ...api, state })
    expect(api.posts).not.toContain('POST /books')
    expect(api.posts.filter((item: string) => item === 'POST /books/book-1/actions')).toHaveLength(1)
  })

  it('recovers a sent DEFEND by reading its action instead of repeating the POST', async () => {
    const api = fakeApi()
    api.actions.push({ id: 'existing-defend', kind: 'DEFEND', status: 'CONFIRMED', amount: 1 })
    const state = {
      runId: 'resume-2',
      phase: 'MANUAL_DEFEND',
      startedAt: new Date(api.now()).toISOString(),
      bookId: 'book-1',
      actionIntents: { DEFEND: { at: api.now(), status: 'SENDING', knownIds: [] } },
    }
    await runAutonomous(config, { ...api, state })
    expect(api.posts.filter((item: string) => item === 'POST /books/book-1/actions')).toHaveLength(1)
  })

  it('refuses mainnet, wrong chain, and excessive reserve before any fetch', () => {
    expect(() => validateConfig({ ...config, chainId: 1 })).toThrow('MONAD_TESTNET_CHAIN_REQUIRED')
    expect(() => validateConfig({ ...config, perplRestUrl: 'https://app.perpl.xyz' })).toThrow('MAINNET_TARGET_REFUSED')
    expect(() => validateConfig({ ...config, reserve: 5.000001 })).toThrow('RUN_BUDGET_LIMIT')
  })
})
