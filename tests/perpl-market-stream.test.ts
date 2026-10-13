import { describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { PerplMarketStream } from '../packages/perpl/src/marketStream.js'
import { normalizeMarketStream } from '../packages/perpl/src/marketDecoder.js'

describe('Perpl market stream lifecycle', () => {
  it.each(['milliseconds', 'seconds'])(
    'recovers stalled prices despite fresh depth, heartbeats and other markets (%s)',
    async (unit) => {
      const server = new WebSocketServer({ port: 0 })
      let now = Math.floor(Date.now() / 1000) * 1000
      const start = now
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
      const timestamp = (value: number) => (unit === 'seconds' ? value / 1000 : value)
      let connections = 0
      server.on('connection', (socket) => {
        const connection = ++connections
        socket.on('message', (raw) => {
          const frame = JSON.parse(String(raw)) as { mt?: number; subs?: Array<{ stream: string }> }
          if (frame.mt !== 5) return
          const subscriptions = (frame.subs ?? []).map((item, index) => ({
            stream: item.stream,
            sid: index + 1,
            status: { code: 0 },
          }))
          socket.send(JSON.stringify({ mt: 6, subs: subscriptions }))
          // Recovery must preserve old venue timestamps until the venue really
          // returns a newer price; another market's updates are not proof.
          socket.send(
            JSON.stringify({
              mt: 9,
              d: {
                '1': { mrk: 100, bid: 99, ask: 101, at: { t: timestamp(connection < 3 ? start : now) } },
                '16': { mrk: 200, bid: 199, ask: 201, at: { t: timestamp(now) } },
              },
            }),
          )
          for (const book of subscriptions.filter((item) => item.stream.startsWith('order-book@')))
            socket.send(
              JSON.stringify({ mt: 15, sid: book.sid, at: { t: now }, bid: [{ p: 99, s: 1, o: 1 }], ask: [] }),
            )
        })
      })
      let stream: PerplMarketStream | undefined
      const activeTraffic = async () => {
        for (const socket of server.clients) {
          socket.send(JSON.stringify({ mt: 100, h: 123 }))
          socket.send(JSON.stringify({ mt: 9, d: { '16': { mrk: 200, bid: 199, ask: 201, at: { t: now } } } }))
          for (const sid of [1, 2]) socket.send(JSON.stringify({ mt: 16, sid, at: { t: now }, bid: [], ask: [] }))
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect((await stream!.snapshot(1))?.book?.timestamp).toBe(now)
      }
      try {
        await new Promise<void>((resolve) => server.once('listening', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('TEST_WS_ADDRESS_UNAVAILABLE')
        stream = new PerplMarketStream(`ws://127.0.0.1:${address.port}`)
        await stream.ensure([1, 16])
        expect(normalizeMarketStream((await stream.snapshot(1))!, 'perpl-ws', now)?.marketTimestamp).toBe(start)
        now += 11_000
        await activeTraffic()
        await stream.ensure([1, 16])
        expect(connections).toBe(1) // The existing reconnect backoff still applies.
        const stale = normalizeMarketStream((await stream.snapshot(1))!, 'perpl-ws', now)
        expect(stale?.freshness?.market.status).toBe('STALE')
        expect(stale?.freshness?.orderbook.status).toBe('FRESH')
        expect(stream.health().fresh).toBe(true)
        now += 20_000
        await activeTraffic()
        await stream.ensure([1, 16])
        const old = normalizeMarketStream((await stream.snapshot(1))!, 'perpl-ws', now)
        expect(connections).toBe(2)
        expect(old?.marketTimestamp).toBe(start)
        expect(old?.freshness?.market.status).toBe('STALE')
        expect(old?.freshness?.orderbook.status).toBe('FRESH')
        expect(normalizeMarketStream((await stream.snapshot(16))!, 'perpl-ws', now)?.freshness?.market.status).toBe(
          'FRESH',
        )
        now += 29_999
        await activeTraffic()
        await stream.ensure([1, 16])
        expect(connections).toBe(2)
        now += 2
        await activeTraffic()
        await stream.ensure([1, 16])
        const recovered = normalizeMarketStream((await stream.snapshot(1))!, 'perpl-ws', now)
        expect(connections).toBe(3)
        expect(recovered?.marketTimestamp).toBe(now)
        expect(recovered?.freshness?.market.status).toBe('FRESH')
        expect(recovered?.freshness?.orderbook.status).toBe('FRESH')
        await stream.ensure([1, 16])
        expect(connections).toBe(3)
      } finally {
        stream?.close()
        clock.mockRestore()
        for (const socket of server.clients) socket.terminate()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
    10_000,
  )

  it.each([undefined, 0])('recovers an unknown market timestamp (%s) without inventing freshness', async (stamp) => {
    const server = new WebSocketServer({ port: 0 })
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    let connections = 0
    server.on('connection', (socket) => {
      const connection = ++connections
      socket.on('message', (raw) => {
        if (JSON.parse(String(raw)).mt !== 5) return
        socket.send(JSON.stringify({ mt: 6, subs: [{ stream: 'order-book@1', sid: 1, status: { code: 0 } }] }))
        socket.send(
          JSON.stringify({
            mt: 9,
            d: { '1': { mrk: 100, bid: 99, ask: 101, at: { t: connection === 1 ? stamp : now } } },
          }),
        )
        socket.send(JSON.stringify({ mt: 15, sid: 1, at: { t: now }, bid: [], ask: [] }))
      })
    })
    let stream: PerplMarketStream | undefined
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('TEST_WS_ADDRESS_UNAVAILABLE')
      stream = new PerplMarketStream(`ws://127.0.0.1:${address.port}`)
      await stream.ensure([1])
      expect(normalizeMarketStream((await stream.snapshot(1))!, 'perpl-ws', now)).toBeNull()
      now += 30_001
      for (const socket of server.clients)
        socket.send(JSON.stringify({ mt: 16, sid: 1, at: { t: now }, bid: [], ask: [] }))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect((await stream.snapshot(1))?.book?.timestamp).toBe(now)
      await stream.ensure([1])
      const recovered = normalizeMarketStream((await stream.snapshot(1))!, 'perpl-ws', now)
      expect(connections).toBe(2)
      expect(recovered?.marketTimestamp).toBe(now)
      expect(recovered?.freshness?.market.status).toBe('FRESH')
    } finally {
      stream?.close()
      clock.mockRestore()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('recovers stalled depth on an open socket without changing source timestamps or trusting market updates', async () => {
    const server = new WebSocketServer({ port: 0 })
    let now = Date.now()
    const start = now
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    let connections = 0
    server.on('connection', (socket) => {
      const connection = ++connections
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as { mt?: number; subs?: Array<{ stream: string }> }
        if (frame.mt !== 5) return
        const subscriptions = (frame.subs ?? []).map((item, index) => ({
          stream: item.stream,
          sid: index + 1,
          status: { code: 0 },
        }))
        socket.send(JSON.stringify({ mt: 6, subs: subscriptions }))
        socket.send(JSON.stringify({ mt: 9, d: { '16': { mrk: 100, bid: 99, ask: 101, at: { t: now } } } }))
        const book = subscriptions.find((item) => item.stream === 'order-book@16')!
        // Second connection deliberately returns old venue data: reconnect itself
        // must not manufacture freshness. The third finally returns a fresh snapshot.
        const timestamp = connection < 3 ? start : now
        socket.send(
          JSON.stringify({
            mt: 15,
            sid: book.sid,
            at: { t: timestamp },
            bid: [{ p: 99, s: connection, o: 1 }],
            ask: [],
          }),
        )
      })
    })
    let stream: PerplMarketStream | undefined
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('TEST_WS_ADDRESS_UNAVAILABLE')
      stream = new PerplMarketStream(`ws://127.0.0.1:${address.port}`)
      await stream.ensure([16])
      const initial = await stream.snapshot(16)
      expect(normalizeMarketStream(initial!, 'perpl-ws', now)?.freshness?.orderbook.status).toBe('FRESH')
      now += 11_000
      await stream.ensure([16])
      const stale = await stream.snapshot(16)
      expect(normalizeMarketStream(stale!, 'perpl-ws', now)?.freshness?.orderbook.status).toBe('STALE')
      expect(connections).toBe(1) // Backoff prevents reconnecting on every poll.
      now += 20_000
      await stream.ensure([16])
      const oldSnapshot = await stream.snapshot(16)
      const telemetry = normalizeMarketStream(oldSnapshot!, 'perpl-ws', now)
      expect(connections).toBe(2)
      expect(telemetry?.freshness?.market.status).toBe('FRESH')
      expect(telemetry?.freshness?.orderbook.status).toBe('STALE')
      expect(telemetry?.orderbookTimestamp).toBe(start)
      await stream.ensure([16])
      expect(connections).toBe(2)
      now += 30_001
      await stream.ensure([16])
      const recovered = normalizeMarketStream((await stream.snapshot(16))!, 'perpl-ws', now)
      expect(connections).toBe(3)
      expect(recovered?.freshness?.orderbook.status).toBe('FRESH')
      expect(recovered?.orderbookTimestamp).toBe(now)
      expect(recovered?.depthNotional).toBe(297)
    } finally {
      stream?.close()
      clock.mockRestore()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 10_000)

  it('refreshes normalized state after reconnect', async () => {
    const server = new WebSocketServer({ port: 0 })
    let connections = 0
    const firstTimestamp = Date.now() - 300
    const secondTimestamp = Date.now() - 100
    server.on('connection', (socket) => {
      const connection = ++connections
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as { mt?: number; subs?: Array<{ stream: string }> }
        if (frame.mt !== 5) return
        const subscriptions = (frame.subs ?? []).map((item, index) => ({
          stream: item.stream,
          sid: index + 1,
          status: { code: 0 },
        }))
        socket.send(JSON.stringify({ mt: 6, subs: subscriptions }))
        const timestamp = connection === 1 ? firstTimestamp : secondTimestamp
        socket.send(
          JSON.stringify({
            mt: 9,
            d: { '1': { mrk: 100, orl: 100, bid: 99, ask: 101, mid: 100, dv: 1, oi: 1, at: { t: timestamp } } },
          }),
        )
        const orderBook = subscriptions.find((item) => item.stream === 'order-book@1')
        if (orderBook)
          socket.send(
            JSON.stringify({
              mt: 15,
              sid: orderBook.sid,
              at: { t: timestamp },
              bid: [{ p: 99, s: 1, o: 1 }],
              ask: [{ p: 101, s: 1, o: 1 }],
            }),
          )
        if (connection === 1) setTimeout(() => socket.close(), 50)
      })
    })
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('TEST_WS_ADDRESS_UNAVAILABLE')
      const stream = new PerplMarketStream(`ws://127.0.0.1:${address.port}`)
      try {
        await stream.ensure([1])
        const initial = await stream.snapshot(1, 1_000)
        expect((initial?.market?.at as { t?: number } | undefined)?.t).toBe(firstTimestamp)
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 5_000
          const poll = () => {
            void stream.snapshot(1, 50).then((state) => {
              if ((state?.market?.at as { t?: number } | undefined)?.t === secondTimestamp) resolve()
              else if (Date.now() >= deadline) reject(new Error('PERPL_STREAM_RECONNECT_TIMEOUT'))
              else setTimeout(poll, 100)
            })
          }
          poll()
        })
        const final = await stream.snapshot(1, 100)
        expect((final?.market?.at as { t?: number } | undefined)?.t).toBe(secondTimestamp)
      } finally {
        stream.close()
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 10_000)
})
