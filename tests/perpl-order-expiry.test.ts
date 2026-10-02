import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import type { Action, VenueProgress } from '../packages/domain/src/index.js'
import type { Ed25519PerplSigner } from '../packages/perpl/src/signer.js'
import { PerplTradingClient } from '../packages/perpl/src/trading.js'
import { PerplLiveAdapter } from '../packages/perpl/src/live.js'
import type { ReconciliationContext } from '../packages/perpl/src/live.js'

const signer = { apiKey: 'fake-key', signWebSocket: async () => 'fake-signature' } as unknown as Ed25519PerplSigner
let server: WebSocketServer | undefined
let client: PerplTradingClient | undefined
let peer: WebSocket | undefined

async function connected() {
  server = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => server!.once('listening', resolve))
  server.on('connection', (socket) => {
    peer = socket
    socket.on('message', (raw) => {
      if ((JSON.parse(String(raw)) as { mt: number }).mt !== 29) return
      socket.send(JSON.stringify({ mt: 3, cid: 1, status: { code: 0 } }))
      socket.send(
        JSON.stringify({
          mt: 19,
          sn: 9,
          addr: 'fake-wallet',
          as: [{ id: 642, in: 1, fr: false, fw: true, ft: 0, lfr: 44, b: '100000000', lb: '0' }],
        }),
      )
      socket.send(JSON.stringify({ mt: 23, d: [] }))
      socket.send(JSON.stringify({ mt: 26, d: [] }))
      socket.send(JSON.stringify({ mt: 100, sn: 10, h: 100 }))
    })
  })
  client = new PerplTradingClient(
    {
      environment: 'testnet',
      restUrl: '',
      wsUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      chainId: 10143,
      rpcUrl: '',
      exchangeAddress: '',
      collateralToken: '',
    },
    signer,
    () => undefined,
  )
  await client.connect()
  return client
}

const action = (progress: VenueProgress): Action => ({
  id: 'action',
  bookId: 'book',
  decisionId: 'decision',
  kind: 'DEFEND',
  amount: 1,
  status: 'UNKNOWN',
  idempotencyKey: 'once',
  venueReference: '642:45',
  venueProgress: progress,
})

function progress(value: PerplTradingClient, overrides: Partial<VenueProgress> = {}): VenueProgress {
  const heartbeat = value.heartbeat()!
  return {
    requestId: '45',
    clientSequence: 1,
    admitted: false,
    requestedLastExecBlock: 102,
    sentHeartbeatHead: heartbeat.head,
    sentHeartbeatSequence: heartbeat.sequence,
    streamEpoch: heartbeat.epoch,
    orderStatusReceived: false,
    response: 'TIMEOUT',
    ...overrides,
  }
}

afterEach(async () => {
  client?.close()
  peer?.close()
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  client = undefined
  peer = undefined
  server = undefined
})

describe('Perpl bounded order expiry', () => {
  it('proves expiry only after every heartbeat advances past the requested block', async () => {
    const value = await connected()
    const sent = progress(value)
    expect(value.expiryProven(sent)).toBe(false)
    peer!.send(JSON.stringify({ mt: 100, sn: 11, h: 101 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(value.expiryProven(sent)).toBe(false)
    peer!.send(JSON.stringify({ mt: 100, sn: 12, h: 102 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(value.expiryProven(sent)).toBe(true)
    expect(value.expiryProven({ ...sent, requestedLastExecBlock: 0 })).toBe(false)
    expect(value.expiryProven({ ...sent, admitted: true })).toBe(true)
    expect(value.expiryProven({ ...sent, orderStatusReceived: true })).toBe(false)
    expect(value.expiryProven({ ...sent, orderStatusReceived: undefined })).toBe(false)
    peer!.send(
      JSON.stringify({
        mt: 24,
        d: [{ acc: 642, mkt: 16, oid: 7, rq: '45', st: 2, t: 6, os: 0, fs: 0, at: { b: 102 } }],
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(value.expiryProven(sent)).toBe(false)
  })

  it('never proves expiry across a heartbeat gap, reconnect, or restart', async () => {
    const value = await connected()
    const sent = progress(value)
    peer!.send(JSON.stringify({ mt: 100, sn: 12, h: 102 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(value.expiryProven(sent)).toBe(false)
    value.close()
    expect(value.expiryProven(sent)).toBe(false)
    const restarted = new PerplTradingClient(
      {
        environment: 'testnet',
        restUrl: '',
        wsUrl: `ws://127.0.0.1:${(server!.address() as AddressInfo).port}`,
        chainId: 10143,
        rpcUrl: '',
        exchangeAddress: '',
        collateralToken: '',
      },
      signer,
      () => undefined,
    )
    client = restarted
    await restarted.connect()
    peer!.send(JSON.stringify({ mt: 100, sn: 11, h: 101 }))
    peer!.send(JSON.stringify({ mt: 100, sn: 12, h: 102 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(restarted.expiryProven(sent)).toBe(false)
  })

  it('does not carry continuity through an automatic reconnect', async () => {
    const value = await connected()
    const sent = progress(value)
    peer!.terminate()
    const deadline = Date.now() + 3000
    while ((!value.isReady() || value.heartbeat()?.epoch === sent.streamEpoch) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25))
    expect(value.heartbeat()?.epoch).not.toBe(sent.streamEpoch)
    peer!.send(JSON.stringify({ mt: 100, sn: 11, h: 101 }))
    peer!.send(JSON.stringify({ mt: 100, sn: 12, h: 102 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(value.expiryProven(sent)).toBe(false)
  })

  it('moves an evidence-free UNKNOWN to FAILED only with proven expiry', async () => {
    const value = await connected()
    const sent = progress(value)
    const context = {
      marketId: 16,
      accountId: 642,
      positionId: 77,
      position: {
        bookId: 'book',
        side: 'LONG',
        status: 'OPEN',
        size: 1,
        entryPrice: 100,
        markPrice: 100,
        liquidationPrice: 90,
        leverage: 5,
        unrealizedPnl: 0,
        margin: 20,
      },
      headBlock: 100,
      orderTtlBlocks: 2,
      sizeDecimals: 0,
      priceDecimals: 0,
      leverageHundredths: 500,
      collateralDecimals: 6,
    } as ReconciliationContext
    const history = {
      evidence: async () => ({ orders: [], accounts: [], fills: [], positions: [], collateralSuccess: undefined }),
    }
    const live = new PerplLiveAdapter(
      value,
      async () => context,
      history as never,
      async () => undefined,
    )
    expect((await live.reconcile(action(sent))).status).toBe('UNKNOWN')
    expect((await live.reconcile({ ...action(sent), status: 'VERIFYING' })).status).toBe('VERIFYING')
    const historyUnavailable = new PerplLiveAdapter(
      value,
      async () => context,
      {
        evidence: async () => {
          throw new Error('VENUE_HTTP_429')
        },
      } as never,
      async () => undefined,
    )
    expect((await historyUnavailable.reconcile({ ...action(sent), status: 'VERIFYING' })).status).toBe('VERIFYING')
    peer!.send(JSON.stringify({ mt: 100, sn: 11, h: 101 }))
    peer!.send(JSON.stringify({ mt: 100, sn: 12, h: 102 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await live.reconcile(action(sent))).toMatchObject({ status: 'FAILED', error: 'PERPL_ORDER_WINDOW_EXPIRED' })
    expect(await live.reconcile({ ...action(sent), status: 'VERIFYING' })).toMatchObject({
      status: 'FAILED',
      error: 'PERPL_ORDER_WINDOW_EXPIRED',
    })
    expect(await live.reconcile(action({ ...sent, admitted: true }))).toMatchObject({
      status: 'FAILED',
      error: 'PERPL_ORDER_WINDOW_EXPIRED',
    })
    expect(await live.reconcile({ ...action(sent), kind: 'EXIT' })).toMatchObject({
      status: 'FAILED',
      error: 'PERPL_ORDER_WINDOW_EXPIRED',
    })
    expect((await live.reconcile(action({ ...sent, requestedLastExecBlock: 0 }))).status).toBe('UNKNOWN')
    expect((await live.reconcile(action({ ...sent, requestId: '46' }))).status).toBe('UNKNOWN')
    peer!.terminate()
    const deadline = Date.now() + 3000
    while ((!value.isReady() || value.heartbeat()?.epoch === sent.streamEpoch) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25))
    peer!.send(JSON.stringify({ mt: 100, sn: 11, h: 101 }))
    peer!.send(JSON.stringify({ mt: 100, sn: 12, h: 102 }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await live.reconcile(action({ ...sent, admitted: true }))).status).toBe('UNKNOWN')
    expect((await live.reconcile({ ...action(sent), status: 'VERIFYING' })).status).toBe('UNKNOWN')
  })
})
