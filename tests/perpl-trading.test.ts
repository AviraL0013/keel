import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { Ed25519PerplSigner } from '../packages/perpl/src/signer.js'
import { PerplTradingClient } from '../packages/perpl/src/trading.js'

const signer = { apiKey: 'read-only-test-key', signWebSocket: async () => 'safe-test-signature' } as unknown as Ed25519PerplSigner
const config = (port: number) => ({ environment: 'testnet' as const, restUrl: '', wsUrl: `ws://127.0.0.1:${port}`, chainId: 10143, rpcUrl: '', exchangeAddress: '', collateralToken: '' })
const wallet = { mt: 19, sn: 9, addr: '0xwallet', as: [{ id: 642, in: 1, fr: false, fw: true, ft: 0, lfr: 44, b: '100000000', lb: '0' }] }
const walletNoForwarding = { ...wallet, as: [{ ...wallet.as[0], fw: false }] }
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
})
