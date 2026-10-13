import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { PerplTradingClient } from '../packages/perpl/src/trading.js'
import { PerplMarketStream } from '../packages/perpl/src/marketStream.js'
import type { Ed25519PerplSigner } from '../packages/perpl/src/signer.js'
import { subscribePerplReliability, type PerplReliabilityEvent } from '../packages/perpl/src/reliability-events.js'

const servers: WebSocketServer[] = []
const cleanup: Array<() => void> = []
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 4_000
  while (!predicate()) {
    if (performance.now() > deadline) throw Error('TEST_RELIABILITY_EVENT_TIMEOUT')
    await sleep(10)
  }
}
async function listen(onConnection: (socket: WebSocket) => void) {
  const server = new WebSocketServer({ port: 0 })
  servers.push(server)
  server.on('connection', onConnection)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  return (server.address() as AddressInfo).port
}
function observe() {
  const events: PerplReliabilityEvent[] = []
  cleanup.push(subscribePerplReliability((event) => events.push(event)))
  return events
}
function tradingClient(port: number) {
  const client = new PerplTradingClient(
    {
      environment: 'testnet',
      restUrl: '',
      wsUrl: `ws://127.0.0.1:${port}`,
      chainId: 10143,
      rpcUrl: '',
      exchangeAddress: '',
      collateralToken: '',
    },
    {
      apiKey: 'fixture-private-token',
      signWebSocket: async () => 'fixture-signature',
    } as unknown as Ed25519PerplSigner,
    () => undefined,
  )
  cleanup.push(() => client.close())
  return client
}
function tradingSnapshots(socket: WebSocket) {
  socket.send(
    JSON.stringify({
      mt: 19,
      sn: 9,
      addr: '0x1234567890123456789012345678901234567890',
      as: [{ id: 642, in: 1, fr: false, fw: true, ft: 0, lfr: 44, b: '100000000', lb: '0' }],
    }),
  )
  socket.send(JSON.stringify({ mt: 23, d: [] }))
  socket.send(JSON.stringify({ mt: 26, d: [] }))
  socket.send(JSON.stringify({ mt: 100, sn: 10, h: 100 }))
}
function marketSnapshots(socket: WebSocket, frame: { subs?: Array<{ stream: string }> }) {
  const subs = (frame.subs ?? []).map((item, index) => ({ ...item, sid: index + 1, status: { code: 0 } }))
  socket.send(JSON.stringify({ mt: 6, subs }))
  socket.send(JSON.stringify({ mt: 9, d: { '1': { mrk: 100, bid: 99, ask: 101, at: { t: Date.now() } } } }))
  const book = subs.find((item) => item.stream === 'order-book@1')!
  socket.send(JSON.stringify({ mt: 15, sid: book.sid, at: { t: Date.now() }, bid: [{ p: 99, s: 1, o: 1 }], ask: [] }))
}
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) stop()
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('sanitized Perpl transport reliability events', () => {
  it('records actual trading readiness, unexpected close and recovered readiness without private data', async () => {
    const events = observe()
    let first: WebSocket | undefined
    const port = await listen((socket) => {
      first ??= socket
      socket.on('message', (raw) => {
        if (JSON.parse(String(raw)).mt === 29) tradingSnapshots(socket)
      })
    })
    const client = tradingClient(port)
    await client.connect()
    expect(events.map((event) => event.kind)).toEqual(['websocket_ready'])
    first!.close(1000, 'fixture-private-token 0x1234567890123456789012345678901234567890')
    await waitFor(() => events.some((event) => event.kind === 'websocket_reconnect'))
    expect(client.isReady()).toBe(true)
    expect(events.map((event) => event.kind)).toEqual([
      'websocket_ready',
      'websocket_disconnect',
      'websocket_reconnect',
    ])
    expect(new Set(events.map((event) => event.streamId)).size).toBe(1)
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(['at', 'kind', 'scope', 'streamId'])
      expect(event.scope).toBe('trading')
      expect(event.streamId).toMatch(/^[0-9a-f-]{36}$/)
      expect(Number.isFinite(Date.parse(event.at))).toBe(true)
    }
    expect(JSON.stringify(events)).not.toContain('fixture-private-token')
    expect(JSON.stringify(events)).not.toContain('0x1234567890123456789012345678901234567890')
  })

  it('ignores intentional trading stop and removes subscriptions', async () => {
    const events: PerplReliabilityEvent[] = []
    const unsubscribe = subscribePerplReliability((event) => events.push(event))
    cleanup.push(unsubscribe)
    const port = await listen((socket) =>
      socket.on('message', (raw) => {
        if (JSON.parse(String(raw)).mt === 29) tradingSnapshots(socket)
      }),
    )
    const client = tradingClient(port)
    await client.connect()
    client.close()
    await sleep(30)
    expect(events.map((event) => event.kind)).toEqual(['websocket_ready'])
    unsubscribe()
    await tradingClient(port).connect()
    expect(events).toHaveLength(1)
  })

  it('isolates synchronous and asynchronous observer failures from transport and other observers', async () => {
    cleanup.push(
      subscribePerplReliability(() => {
        throw Error('fixture-observer-failed')
      }),
      subscribePerplReliability(async () => {
        throw Error('fixture-async-observer-failed')
      }),
    )
    const events = observe()
    const port = await listen((socket) =>
      socket.on('message', (raw) => {
        if (JSON.parse(String(raw)).mt === 29) tradingSnapshots(socket)
      }),
    )
    const client = tradingClient(port)
    await client.connect()
    await sleep(10)
    expect(client.isReady()).toBe(true)
    expect(events).toHaveLength(1)
  })

  it('records market snapshot readiness and recovery, while ignoring deliberate close', async () => {
    const events = observe()
    let first: WebSocket | undefined
    const port = await listen((socket) => {
      first ??= socket
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw))
        if (frame.mt === 5) marketSnapshots(socket, frame)
      })
    })
    const stream = new PerplMarketStream(`ws://127.0.0.1:${port}`)
    cleanup.push(() => stream.close())
    await stream.ensure([1])
    await stream.snapshot(1)
    expect(events.map((event) => event.kind)).toEqual(['websocket_ready'])
    first!.close()
    await waitFor(() => events.some((event) => event.kind === 'websocket_reconnect'))
    expect(events.map((event) => event.kind)).toEqual([
      'websocket_ready',
      'websocket_disconnect',
      'websocket_reconnect',
    ])
    expect(events.every((event) => event.scope === 'market')).toBe(true)
    expect(new Set(events.map((event) => event.streamId)).size).toBe(1)
    stream.close()
    await sleep(30)
    expect(events).toHaveLength(3)
  })

  it('does not claim market ready from socket open or subscription acknowledgment alone', async () => {
    const events = observe()
    let supplySnapshots: (() => void) | undefined
    const port = await listen((socket) =>
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw))
        if (frame.mt !== 5) return
        socket.send(
          JSON.stringify({
            mt: 6,
            subs: frame.subs.map((item: { stream: string }, index: number) => ({
              ...item,
              sid: index + 1,
              status: { code: 0 },
            })),
          }),
        )
        supplySnapshots = () => marketSnapshots(socket, frame)
      }),
    )
    const stream = new PerplMarketStream(`ws://127.0.0.1:${port}`)
    cleanup.push(() => stream.close())
    await stream.ensure([1])
    await waitFor(() => !!supplySnapshots)
    await sleep(20)
    expect(events).toEqual([])
    supplySnapshots!()
    await stream.snapshot(1)
    expect(events.map((event) => event.kind)).toEqual(['websocket_ready'])
  })

  it('records stalled-depth resynchronization as a failure and recovery', async () => {
    const events = observe()
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const port = await listen((socket) =>
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw))
        if (frame.mt === 5) marketSnapshots(socket, frame)
      }),
    )
    const stream = new PerplMarketStream(`ws://127.0.0.1:${port}`)
    cleanup.push(() => stream.close())
    await stream.ensure([1])
    await stream.snapshot(1)
    now += 31_000
    await stream.ensure([1])
    await stream.snapshot(1)
    expect(events.map((event) => event.kind)).toEqual([
      'websocket_ready',
      'websocket_disconnect',
      'websocket_reconnect',
    ])
  })
})
