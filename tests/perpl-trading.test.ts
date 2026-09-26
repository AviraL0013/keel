import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { Ed25519PerplSigner } from '../packages/perpl/src/signer.js'
import { PerplTradingClient, highestOrderDescIdRejection } from '../packages/perpl/src/trading.js'

const signer = { apiKey: 'read-only-test-key', signWebSocket: async () => 'safe-test-signature' } as unknown as Ed25519PerplSigner
const config = (port: number) => ({ environment: 'testnet' as const, restUrl: '', wsUrl: `ws://127.0.0.1:${port}`, chainId: 10143, rpcUrl: '', exchangeAddress: '', collateralToken: '' })
const wallet = { mt: 19, sn: 9, addr: '0xwallet', as: [{ id: 642, in: 1, fr: false, fw: true, ft: 0, lfr: 44, b: '100000000', lb: '0' }] }
const walletNoForwarding = { ...wallet, as: [{ ...wallet.as[0], fw: false }] }
const currentBaseline = async () => ({ lfr: '44', rejectedForwardedRq: '0' })
const localAllocator = async (_accountId: number, lfr: string) => (BigInt(lfr) + 1n).toString()
const snapshots = (socket: { send: (value: string) => void }) => {
  socket.send(JSON.stringify({ mt: 3, cid: 1, status: { code: 0 } }))
  socket.send(JSON.stringify(wallet))
  socket.send(JSON.stringify({ mt: 23, d: [] }))
  socket.send(JSON.stringify({ mt: 26, d: [] }))
  socket.send(JSON.stringify({ mt: 100, sn: 10 }))
}
const snapshotsWithWallet = (socket: { send: (value: string) => void }, value: unknown) => {
  socket.send(JSON.stringify({ mt: 3, cid: 1, status: { code: 0 } }))
  socket.send(JSON.stringify(value))
  socket.send(JSON.stringify({ mt: 23, d: [] }))
  socket.send(JSON.stringify({ mt: 26, d: [] }))
  socket.send(JSON.stringify({ mt: 100, sn: 10 }))
}

let server: WebSocketServer | undefined
const listen = async (instance: WebSocketServer) => { await new Promise<void>(resolve => instance.once('listening', () => resolve())); return (instance.address() as AddressInfo).port }
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined })

describe('Perpl read-only trading WebSocket lifecycle', () => {
  it('distinguishes real direct order rq from the forwarded sr:32 contradiction', () => {
    const directOrder = { acc: 642, rq: '1789913643242', st: 4, sr: 43 }
    const rejectedForwardedOrder = { acc: 642, rq: '1790412137977', st: 7, sr: 32 }
    expect(highestOrderDescIdRejection([directOrder], 642)).toBe(0n)
    expect(highestOrderDescIdRejection([directOrder, rejectedForwardedOrder], 642)).toBe(1790412137977n)
    expect(highestOrderDescIdRejection([rejectedForwardedOrder], 643)).toBe(0n)
  })
  it('waits for authentication, snapshots, and heartbeat before ready', async () => {
    server = new WebSocketServer({ port: 0 })
    server.on('connection', socket => socket.on('message', raw => { if ((JSON.parse(String(raw)) as { mt?: number }).mt === 29) snapshots(socket) }))
    const port = await listen(server)
    const logs: string[] = []
    const client = new PerplTradingClient(config(port), signer, line => logs.push(line))
    await client.connect()
    expect(client.isReady()).toBe(true)
    expect(client.lifecycleState()).toBe('READY')
    expect(logs).toEqual(expect.arrayContaining(['PERPL_WS_OPEN', 'PERPL_WS_SIGNIN_SENT', 'PERPL_WS_SNAPSHOT mt=19', 'PERPL_WS_SNAPSHOT mt=23', 'PERPL_WS_SNAPSHOT mt=26', 'PERPL_WS_HEARTBEAT mt=100']))
    client.close()
  })

  it('keeps authenticated mt:26 positions with their WS receipt timestamp', async () => {
    server = new WebSocketServer({ port: 0 })
    server.on('connection', socket => socket.on('message', raw => {
      if ((JSON.parse(String(raw)) as { mt?: number }).mt !== 29) return
      socket.send(JSON.stringify({ mt: 3, cid: 1, status: { code: 0 } }))
      socket.send(JSON.stringify(wallet))
      socket.send(JSON.stringify({ mt: 23, d: [] }))
      socket.send(JSON.stringify({ mt: 26, d: [{ pid: 77, acc: 642, mkt: 16, st: 1, sd: 1, c: '1000000', ep: 100, s: 1, lv: 1500, at: { b: 1, t: 1 } }] }))
      socket.send(JSON.stringify({ mt: 100, sn: 10 }))
    }))
    const port = await listen(server)
    const client = new PerplTradingClient(config(port), signer)
    await client.connect()
    const snapshot = client.positionSnapshot(642, 16, 77)
    expect(snapshot?.position.pid).toBe(77)
    expect(snapshot?.observedAt).toEqual(expect.any(Number))
    client.close()
  })

  it('fails closed when authentication rejects the read-only key', async () => {
    server = new WebSocketServer({ port: 0 })
    server.on('connection', socket => socket.on('message', raw => { if ((JSON.parse(String(raw)) as { mt?: number }).mt === 29) socket.send(JSON.stringify({ mt: 3, cid: 1, status: { code: 3401, error: 'UNAUTHORIZED' } })) }))
    const port = await listen(server)
    const client = new PerplTradingClient(config(port), signer)
    await expect(client.connect()).rejects.toThrow('PERPL_WS_AUTH_FAILED')
    expect(client.isReady()).toBe(false)
    expect(client.lifecycleState()).toBe('FAILED')
    client.close()
  })

  it('reconnects after disconnect and rebuilds snapshots', async () => {
    server = new WebSocketServer({ port: 0 })
    let connections = 0
    server.on('connection', socket => { connections += 1; socket.on('message', raw => { if ((JSON.parse(String(raw)) as { mt?: number }).mt === 29) { snapshots(socket); if (connections === 1) setTimeout(() => socket.terminate(), 20) } }) })
    const port = await listen(server)
    const client = new PerplTradingClient(config(port), signer)
    await client.connect()
    await new Promise(resolve => setTimeout(resolve, 1300))
    expect(connections).toBeGreaterThanOrEqual(2)
    expect(client.isReady()).toBe(true)
    client.close()
  })

  it('marks malformed snapshots unsafe', async () => {
    server = new WebSocketServer({ port: 0 })
    server.on('connection', socket => socket.on('message', raw => { if ((JSON.parse(String(raw)) as { mt?: number }).mt === 29) { socket.send(JSON.stringify({ mt: 19, sn: 9, addr: '0xwallet', as: [] })); socket.send(JSON.stringify({ mt: 26, d: [{ acc: 642 }] })) } }))
    const port = await listen(server)
    const client = new PerplTradingClient(config(port), signer)
    await expect(client.connect()).rejects.toThrow('PERPL_WS_DECODE_FAILED')
    expect(client.isReady()).toBe(false)
    expect(['STALE', 'RECONNECTING']).toContain(client.lifecycleState())
    client.close()
  })

  it('reports forwarding disabled as authorization failure, without sending an order', async () => {
    server = new WebSocketServer({ port: 0 })
    let orderFrames = 0
    server.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { mt?: number }
      if (frame.mt === 29) snapshotsWithWallet(socket, walletNoForwarding)
      if (frame.mt === 22) orderFrames += 1
    }))
    const port = await listen(server)
    const client = new PerplTradingClient(config(port), signer)
    await client.connect()
    const error = await client.submit({} as never, { mkt: 16, acc: 642, t: 1, s: 1, lv: 1500 })
      .then(() => undefined, value => value as Error & { statusCode?: number })
    expect(error?.message).toBe('PERPL_ORDER_FORWARDING_DISABLED')
    expect(error?.statusCode).toBe(403)
    expect(orderFrames).toBe(0)
    client.close()
  })

  it('classifies a correlated mt:3 rejection as FAILED without losing authenticated WS readiness', async () => {
    server = new WebSocketServer({ port: 0 })
    let sent: { mt: number; sn: number; rq: number } | undefined
    server.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { mt: number; sn: number; rq: number }
      if (frame.mt === 29) snapshots(socket)
      if (frame.mt === 22) { sent = frame; socket.send(JSON.stringify({ mt: 3, cid: frame.sn, status: { code: 403, error: 'api key lacks trade scope' } })) }
    }))
    const client = new PerplTradingClient(config(await listen(server)), signer, () => undefined, localAllocator, currentBaseline)
    try {
      await client.connect()
      const result = await client.submit({ id: 'manual-action' } as never, { mkt: 16, acc: 642, t: 6, s: 0, lv: 1500 })
      expect(sent).toMatchObject({ mt: 22, sn: 1 })
      expect(sent!.rq).toBe(45)
      expect(result).toMatchObject({ status: 'FAILED', venueReference: `642:${sent!.rq}`, reason: 'PERPL_ORDER_REJECTED_403' })
      expect(client.isReady()).toBe(true)
      expect(client.lifecycleState()).toBe('READY')
    } finally { client.close() }
  })

  it('does not emit mt:22 when durable reference persistence fails before send', async () => {
    server = new WebSocketServer({ port: 0 })
    let orderFrames = 0
    server.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { mt: number }
      if (frame.mt === 29) snapshots(socket)
      if (frame.mt === 22) orderFrames += 1
    }))
    const client = new PerplTradingClient(config(await listen(server)), signer, () => undefined, localAllocator, currentBaseline)
    try {
      await client.connect()
      await expect(client.submit({ id: 'manual-action' } as never, { mkt: 16, acc: 642, t: 6, s: 0, lv: 1500 }, async () => { throw new Error('DURABLE_REFERENCE_FAILED') })).rejects.toThrow('DURABLE_REFERENCE_FAILED')
      expect(orderFrames).toBe(0)
    } finally { client.close() }
  })

  it('keeps a transport loss after mt:22 UNKNOWN for independent reconciliation', async () => {
    server = new WebSocketServer({ port: 0 })
    let orderFrames = 0
    server.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { mt: number }
      if (frame.mt === 29) snapshots(socket)
      if (frame.mt === 22) { orderFrames += 1; socket.terminate() }
    }))
    const client = new PerplTradingClient(config(await listen(server)), signer, () => undefined, localAllocator, currentBaseline)
    try {
      await client.connect()
      expect(await client.submit({ id: 'manual-action' } as never, { mkt: 16, acc: 642, t: 6, s: 0, lv: 1500 })).toMatchObject({ status: 'UNKNOWN', reason: 'PERPL_ORDER_TRANSPORT_AMBIGUOUS' })
      expect(orderFrames).toBe(1)
    } finally { client.close() }
  })

  it('uses durable request history after restart and fails closed if history cannot be read', async () => {
    server = new WebSocketServer({ port: 0 })
    const frames: Array<{ mt: number; rq: number; sn: number }> = []
    server.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { mt: number; rq: number; sn: number }
      if (frame.mt === 29) snapshots(socket)
      if (frame.mt === 22) { frames.push(frame); socket.send(JSON.stringify({ mt: 3, cid: frame.sn, status: { code: 403, error: 'test rejection' } })) }
    }))
    const port = await listen(server)
    const floor = Date.now() + 100_000
    const first = new PerplTradingClient(config(port), signer, () => undefined, async () => String(floor + 1), currentBaseline)
    const second = new PerplTradingClient(config(port), signer, () => undefined, async () => { throw new Error('DB_UNAVAILABLE') }, currentBaseline)
    try {
      await first.connect()
      await second.connect()
      await first.submit({ id: 'first' } as never, { mkt: 16, acc: 642, t: 6, s: 0, lv: 1500 })
      expect(frames[0].rq).toBe(floor + 1)
      await expect(second.submit({ id: 'second' } as never, { mkt: 16, acc: 642, t: 6, s: 0, lv: 1500 })).rejects.toThrow('PERPL_REQUEST_ID_ALLOCATION_FAILED')
      expect(frames).toHaveLength(1)
    } finally { first.close(); second.close() }
  })

  it('treats accepted mt:3 as admission only and waits for mt:24 order outcome', async () => {
    server = new WebSocketServer({ port: 0 })
    server.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { mt: number; sn: number; rq: number }
      if (frame.mt === 29) snapshots(socket)
      if (frame.mt === 22) {
        socket.send(JSON.stringify({ mt: 3, cid: frame.sn, status: { code: 0 } }))
        socket.send(JSON.stringify({ mt: 24, d: [{ acc: 642, mkt: 16, oid: 3, rq: frame.rq, st: 2, t: 6, os: 0, fs: 0, at: { b: 1 } }] }))
      }
    }))
    const client = new PerplTradingClient(config(await listen(server)), signer, () => undefined, localAllocator, currentBaseline)
    try {
      await client.connect()
      const result = await client.submit({ id: 'manual-action' } as never, { mkt: 16, acc: 642, t: 6, s: 0, lv: 1500 })
      expect(result.status).toBe('CONFIRMED')
      expect(result.venueReference).toMatch(/^642:\d+:3$/)
    } finally { client.close() }
  })

  it('blocks an unresolved forwarded sr:32 above fresh lfr before allocation or mt:22', async () => {
    server = new WebSocketServer({ port: 0 })
    let orders = 0, allocations = 0
    server.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { mt: number }
      if (frame.mt === 29) snapshots(socket)
      if (frame.mt === 22) orders++
    }))
    const client = new PerplTradingClient(config(await listen(server)), signer, () => undefined,
      async () => { allocations++; return '46' }, async () => ({ lfr: '44', rejectedForwardedRq: '1790412137977' }))
    try {
      await client.connect()
      await expect(client.submit({ id: 'manual-action' } as never, { mkt: 16, acc: 642, t: 6, s: 0, lv: 1500 })).rejects.toThrow('PERPL_REQUEST_ID_FORWARDED_REJECTION_UNRESOLVED')
      expect({ orders, allocations }).toEqual({ orders: 0, allocations: 0 })
    } finally { client.close() }
  })

  it('does not treat a direct on-chain order rq as the API forwarding baseline', async () => {
    server = new WebSocketServer({ port: 0 })
    let sentRq: number | undefined
    server.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { mt: number; rq?: number; sn?: number }
      if (frame.mt === 29) snapshotsWithWallet(socket, { ...wallet, as: [{ ...wallet.as[0], lfr: 0 }] })
      if (frame.mt === 22) {
        sentRq = frame.rq
        socket.send(JSON.stringify({ mt: 3, cid: frame.sn, status: { code: 403 } }))
      }
    }))
    const client = new PerplTradingClient(config(await listen(server)), signer, () => undefined,
      async (_accountId, lfr) => (BigInt(lfr) + 1n).toString(),
      async () => ({ lfr: '0', rejectedForwardedRq: '0' }))
    try {
      await client.connect()
      await client.submit({ id: 'manual-action' } as never, { mkt: 16, acc: 642, t: 6, s: 0, lv: 1500 })
      expect(sentRq).toBe(1)
    } finally { client.close() }
  })

  it('blocks missing authoritative lfr without emitting mt:22', async () => {
    server = new WebSocketServer({ port: 0 })
    let orders = 0
    server.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { mt: number }
      if (frame.mt === 29) snapshots(socket)
      if (frame.mt === 22) orders++
    }))
    const client = new PerplTradingClient(config(await listen(server)), signer, () => undefined, localAllocator,
      async () => ({ lfr: '', rejectedForwardedRq: '0' }))
    try {
      await client.connect()
      await expect(client.submit({ id: 'manual-action' } as never, { mkt: 16, acc: 642, t: 6, s: 0, lv: 1500 })).rejects.toThrow('PERPL_REQUEST_ID_BASELINE_INVALID')
      expect(orders).toBe(0)
    } finally { client.close() }
  })

  it('allocates unique increasing IDs for concurrent submissions', async () => {
    server = new WebSocketServer({ port: 0 })
    const seen: string[] = []
    server.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { mt: number; sn: number; rq: number }
      if (frame.mt === 29) snapshots(socket)
      if (frame.mt === 22) { seen.push(String(frame.rq)); socket.send(JSON.stringify({ mt: 3, cid: frame.sn, status: { code: 403 } })) }
    }))
    let last = 44n
    const client = new PerplTradingClient(config(await listen(server)), signer, () => undefined,
      async () => { await new Promise(resolve => setTimeout(resolve, 1)); return (++last).toString() }, currentBaseline)
    try {
      await client.connect()
      await Promise.all(Array.from({ length: 4 }, (_, index) => client.submit({ id: `action-${index}` } as never, { mkt: 16, acc: 642, t: 6, s: 0, lv: 1500 })))
      expect(seen).toHaveLength(4)
      expect(new Set(seen).size).toBe(4)
      expect(seen.map(BigInt).sort((a,b) => a < b ? -1 : 1)).toEqual([45n, 46n, 47n, 48n])
    } finally { client.close() }
  })

  it('classifies venue sr:32 as ORDER_REQUEST_ID_TOO_LOW', async () => {
    server = new WebSocketServer({ port: 0 })
    server.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { mt: number; sn: number; rq: number }
      if (frame.mt === 29) snapshots(socket)
      if (frame.mt === 22) socket.send(JSON.stringify({ mt: 24, d: [{ acc: 642, mkt: 16, oid: 3, rq: frame.rq, st: 7, sr: 32, t: 6, os: 0, fs: 0, at: { b: 1 } }] }))
    }))
    const client = new PerplTradingClient(config(await listen(server)), signer, () => undefined, localAllocator, currentBaseline)
    try {
      await client.connect()
      expect(await client.submit({ id: 'manual-action' } as never, { mkt: 16, acc: 642, t: 6, s: 0, lv: 1500 })).toMatchObject({ status: 'FAILED', reason: 'ORDER_REQUEST_ID_TOO_LOW' })
    } finally { client.close() }
  })

  it('classifies an immediate mt:3 code 32 rejection the same way', async () => {
    server = new WebSocketServer({ port: 0 })
    server.on('connection', socket => socket.on('message', raw => {
      const frame = JSON.parse(String(raw)) as { mt: number; sn: number }
      if (frame.mt === 29) snapshots(socket)
      if (frame.mt === 22) socket.send(JSON.stringify({ mt: 3, cid: frame.sn, status: { code: 32 } }))
    }))
    const client = new PerplTradingClient(config(await listen(server)), signer, () => undefined, localAllocator, currentBaseline)
    try {
      await client.connect()
      expect(await client.submit({ id: 'manual-action' } as never, { mkt: 16, acc: 642, t: 6, s: 0, lv: 1500 })).toMatchObject({ status: 'FAILED', reason: 'ORDER_REQUEST_ID_TOO_LOW' })
    } finally { client.close() }
  })
})
