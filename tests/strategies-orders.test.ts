import { describe, expect, it } from 'vitest'
import { FakeMatchingEngine } from '../packages/strategies/src/fake-matching-engine.js'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { Ed25519PerplSigner } from '../packages/perpl/src/signer.js'
import { PerplTradingClient } from '../packages/perpl/src/trading.js'

describe('strategy fake matching engine', () => {
  it('rests a post-only quote and rejects a crossing quote', () => {
    const venue = new FakeMatchingEngine(100, 101)
    expect(venue.post({ id: 'buy', side: 'BUY', price: 99, size: 1, postOnly: true }).status).toBe('OPEN')
    expect(venue.post({ id: 'cross', side: 'BUY', price: 101, size: 1, postOnly: true }).status).toBe('REJECTED')
  })
  it('fills IOC only against available size and cancels remainder', () => {
    const venue = new FakeMatchingEngine(100, 101, 0.4, 0.3)
    const result = venue.post({ id: 'take', side: 'BUY', price: 102, size: 1, postOnly: false, ioc: true })
    expect(result.status).toBe('PARTIAL')
    expect(result.filledSize).toBe(0.3)
    expect(venue.openOrders()).toEqual([])
  })
  it('keeps partial maker remainder and cancels it exactly once', () => {
    const venue = new FakeMatchingEngine(100, 101)
    venue.post({ id: 'maker', side: 'BUY', price: 99, size: 2, postOnly: true })
    expect(venue.trade('SELL', 99, 0.75)).toEqual([{ id: 'maker', size: 0.75, price: 99 }])
    expect(venue.openOrders()[0]?.remainingSize).toBe(1.25)
    expect(venue.cancel('maker').status).toBe('CANCELED')
    expect(venue.cancel('maker').status).toBe('REJECTED')
  })
  it('changes price and size without losing existing fills', () => {
    const venue = new FakeMatchingEngine(100, 101)
    venue.post({ id: 'maker', side: 'SELL', price: 102, size: 2, postOnly: true })
    venue.trade('BUY', 102, 0.5)
    expect(venue.change('maker', 103, 1).status).toBe('PARTIAL')
    expect(venue.openOrders()[0]?.remainingSize).toBe(0.5)
    expect(venue.change('maker', 100, 1).status).toBe('REJECTED')
    expect(venue.openOrders()[0]?.price).toBe(103)
  })
})

describe('strategy orders on the shared Perpl trading session', () => {
  it('sends post-only, cancel, and change with unique request IDs and bounded lb', async () => {
    const server = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const frames: Array<Record<string, number>> = []
    server.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, number>
        if (frame.mt === 29) {
          socket.send(JSON.stringify({ mt: 3, cid: 1, status: { code: 0 } }))
          socket.send(
            JSON.stringify({
              mt: 19,
              sn: 9,
              addr: '0xwallet',
              as: [{ id: 642, in: 1, fr: false, fw: true, ft: 0, lfr: 44, b: '100000000', lb: '0' }],
            }),
          )
          socket.send(JSON.stringify({ mt: 23, d: [] }))
          socket.send(JSON.stringify({ mt: 26, d: [] }))
          socket.send(JSON.stringify({ mt: 100, sn: 10, h: 100 }))
        }
        if (frame.mt === 22) {
          frames.push(frame)
          if (frame.p === 96) {
            socket.terminate()
            return
          }
          socket.send(JSON.stringify({ mt: 3, cid: frame.sn, status: { code: 0 } }))
          socket.send(
            JSON.stringify({
              mt: 24,
              d: [
                {
                  at: { b: 101, t: 1000 },
                  acc: 642,
                  mkt: 16,
                  oid: 75,
                  rq: frame.rq,
                  st: frame.t === 5 ? 5 : frame.p === 97 ? 7 : 2,
                  t: frame.t,
                  os: frame.s,
                  fs: 0,
                },
              ],
            }),
          )
        }
      }),
    )
    let allocated = 44n
    const signer = { apiKey: 'test', signWebSocket: async () => 'test' } as unknown as Ed25519PerplSigner
    const client = new PerplTradingClient(
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
      async () => String(++allocated),
      async () => ({ lfr: '44', rejectedForwardedRq: '0' }),
    )
    try {
      await client.connect()
      const sent: string[] = []
      const beforeSend = async (reference: string, lb: number) => {
        sent.push(`${reference}:${lb}`)
      }
      const base = { acc: 642, mkt: 16, lb: 120, orderTtlBlocks: 20 }
      expect(
        (await client.submitStrategy('post', { ...base, t: 1, p: 99, s: 1, lv: 200, fl: 1 }, beforeSend)).status,
      ).toBe('SUBMITTED')
      expect(
        (await client.submitStrategy('change', { ...base, t: 7, oid: 75, p: 98, s: 1, lv: 0, fl: 0 }, beforeSend))
          .status,
      ).toBe('SUBMITTED')
      expect(
        (await client.submitStrategy('cancel', { ...base, t: 5, oid: 75, s: 0, lv: 0, fl: 0 }, beforeSend)).status,
      ).toBe('CANCELED')
      expect(
        (await client.submitStrategy('reject', { ...base, t: 1, p: 97, s: 1, lv: 200, fl: 1 }, beforeSend)).status,
      ).toBe('FAILED')
      expect(frames.map((frame) => [frame.t, frame.fl, frame.lb])).toEqual([
        [1, 1, 120],
        [7, 0, 120],
        [5, 0, 120],
        [1, 1, 120],
      ])
      expect(new Set(frames.map((frame) => String(frame.rq))).size).toBe(4)
      expect(sent).toHaveLength(4)
      const ambiguous = await client.submitStrategy(
        'disconnect',
        { ...base, t: 1, p: 96, s: 1, lv: 200, fl: 1 },
        beforeSend,
      )
      expect(ambiguous.status).toBe('UNKNOWN')
      expect(frames).toHaveLength(5)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(frames).toHaveLength(5)
    } finally {
      client.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 25_000)
})
