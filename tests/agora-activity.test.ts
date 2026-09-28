import { describe, expect, it, vi } from 'vitest'
import { AgoraAdapter } from '../packages/chain/src/agora.js'
import { readAgoraActivity } from '../server/src/infrastructure/agora/activity.js'
import { createServer } from '../server/src/index.js'
import { MemoryStore } from '../server/src/memoryStore.js'
import type { Action } from '../packages/domain/src/index.js'

const wallet = '0x1111111111111111111111111111111111111111'
const otherWallet = '0x2222222222222222222222222222222222222222'
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

function response(body: unknown, requestId = 'request-1') {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Request-Id': requestId, 'content-type': 'application/json' },
  })
}

function fixture() {
  const requests: Array<{ path: string; authorization?: string; method?: string }> = []
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    requests.push({
      path,
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
      method: init?.method,
    })
    if (path === '/v0/auth/token') return response({ sessionJwt: 'server-secret' })
    if (path === '/v0/accounts')
      return response({
        data: [
          { id: 'account-1', kind: 'wallet', address: wallet, networks: [{ chain: 'monad' }] },
          { id: 'bank-1', kind: 'bank', accountNumber: 'private-bank-number', routingNumber: 'private-routing-number' },
        ],
        nextCursor: null,
      })
    if (path === '/v0/transactions')
      return response({
        data: [
          {
            id,
            type: 'mint',
            status: 'settled',
            initiatedAt: '2026-09-27T00:00:00Z',
            settledAt: '2026-09-27T00:01:00Z',
            source: { kind: 'bank', accountNumber: 'private-bank-number' },
            recipient: {
              kind: 'wallet',
              chain: 'monad',
              address: wallet,
              amounts: [{ amount: '12.000000', currency: 'ausd' }],
            },
          },
          {
            id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            type: 'mint',
            status: 'settled',
            initiatedAt: '2026-09-27T00:00:00Z',
            settledAt: '2026-09-27T00:01:00Z',
            source: { kind: 'bank', accountNumber: 'other-secret' },
            recipient: {
              kind: 'wallet',
              chain: 'monad',
              address: otherWallet,
              amounts: [{ amount: '99.000000', currency: 'ausd' }],
            },
          },
        ],
        nextCursor: null,
      })
    if (path === `/v0/transactions/${id}`)
      return response({
        id,
        type: 'mint',
        status: 'settled',
        initiatedAt: '2026-09-27T00:00:00Z',
        settledAt: '2026-09-27T00:01:00Z',
        source: { kind: 'bank', accountNumber: 'private-bank-number' },
        recipient: {
          kind: 'wallet',
          chain: 'monad',
          address: wallet,
          amounts: [{ amount: '12.000000', currency: 'ausd' }],
        },
        legs: [
          {
            amount: '12.000000',
            currency: 'ausd',
            occurredAt: '2026-09-27T00:01:00Z',
            source: { kind: 'wallet', chain: 'monad', address: otherWallet },
            recipient: { kind: 'wallet', chain: 'monad', address: wallet },
            detail: { type: 'token', transactionHash: `0x${'a'.repeat(64)}` },
          },
        ],
      })
    throw new Error(`Unexpected path ${path}`)
  }) as unknown as typeof fetch
  const logs: unknown[] = []
  return {
    adapter: new AgoraAdapter('https://api.agora.finance', 'api-secret', (...args) => logs.push(args), fetcher),
    requests,
    logs,
  }
}

describe('read-only Agora activity', () => {
  it('uses documented auth endpoint, caches JWT, and logs only Request-Id metadata', async () => {
    const { adapter, requests, logs } = fixture()
    await adapter.listAccounts()
    await adapter.listTransactions()
    expect(requests.filter((request) => request.path === '/v0/auth/token')).toHaveLength(1)
    expect(requests[0]).toMatchObject({ path: '/v0/auth/token', method: 'POST', authorization: 'Bearer api-secret' })
    expect(requests.slice(1).every((request) => request.authorization === 'Bearer server-secret')).toBe(true)
    expect(JSON.stringify(logs)).not.toContain('secret')
    expect(logs).toContainEqual(['request-1', '/v0/transactions', 200])
  })

  it('shows only connected-wallet activity and never returns bank details or another wallet', async () => {
    const { adapter } = fixture()
    const lookup = vi.fn(async () => 'WALLET_TRANSFER' as const)
    const activity = await readAgoraActivity(adapter, wallet, lookup)
    expect(activity.status).toBe('AVAILABLE')
    expect(activity.rows).toHaveLength(1)
    expect(activity.rows[0]).toMatchObject({
      amount: '12.000000',
      match: 'POSSIBLE_MATCH',
      evidence: 'WALLET_TRANSFER',
    })
    expect(JSON.stringify(activity)).not.toContain('private-bank-number')
    expect(JSON.stringify(activity)).not.toContain('99.000000')
  })

  it('fails closed when wallet is absent or not registered and does not fetch organization transactions', async () => {
    const { adapter, requests } = fixture()
    expect((await readAgoraActivity(adapter, undefined, async () => 'NONE')).reason).toBe('WALLET_NOT_CONNECTED')
    expect((await readAgoraActivity(adapter, otherWallet, async () => 'NONE')).reason).toBe('WALLET_NOT_REGISTERED')
    expect(requests.some((request) => request.path === '/v0/transactions')).toBe(false)
  })

  it('does not claim a match without corroborating on-chain evidence', async () => {
    const { adapter } = fixture()
    const activity = await readAgoraActivity(adapter, wallet, async () => 'NONE')
    expect(activity.rows[0]).toMatchObject({ match: 'UNMATCHED', evidence: 'NONE' })
  })

  it('requires a EYELER session and passes only its wallet to the activity reader', async () => {
    const store = new MemoryStore()
    const userId = await store.ensureUser(wallet)
    await store.createSession('agora-test-session', { userId, walletAddress: wallet, expiresAt: Date.now() + 60_000 })
    const seen: string[] = []
    const venue = {
      agoraActivity: async (address?: string) => {
        seen.push(address ?? '')
        return { status: 'AVAILABLE' as const, rows: [] }
      },
      submit: async () => ({ venueReference: 'unused', status: 'UNKNOWN' as const }),
      reconcile: async (action: Action) => action,
      refresh: async () => undefined,
      ready: () => false,
      close: async () => undefined,
    }
    const previousAllowlist = process.env.EYELER_ALLOWED_WALLETS
    process.env.EYELER_ALLOWED_WALLETS = wallet
    const app = createServer(store, { venue })
    try {
      expect((await app.inject({ url: '/capital/agora-activity' })).statusCode).toBe(401)
      const result = await app.inject({
        url: '/capital/agora-activity',
        headers: { authorization: 'Bearer agora-test-session' },
      })
      expect(result.statusCode).toBe(200)
      expect(result.json()).toEqual({ status: 'AVAILABLE', rows: [] })
      expect(seen).toEqual([wallet])
    } finally {
      await app.close()
      if (previousAllowlist === undefined) delete process.env.EYELER_ALLOWED_WALLETS
      else process.env.EYELER_ALLOWED_WALLETS = previousAllowlist
    }
  })
})
