import { describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { PerplMarketStream } from '../packages/perpl/src/marketStream.js'

describe('Perpl market stream lifecycle', () => {
  it('refreshes normalized state after reconnect', async () => {
    const server = new WebSocketServer({ port: 0 })
    let connections = 0
    const firstTimestamp = Date.now() - 300
    const secondTimestamp = Date.now() - 100
    server.on('connection', socket => {
      const connection = ++connections
      socket.on('message', raw => {
        const frame = JSON.parse(String(raw)) as { mt?: number; subs?: Array<{ stream: string }> }
        if (frame.mt !== 5) return
        const subscriptions = (frame.subs ?? []).map((item, index) => ({ stream: item.stream, sid: index + 1, status: { code: 0 } }))
        socket.send(JSON.stringify({ mt: 6, subs: subscriptions }))
        const timestamp = connection === 1 ? firstTimestamp : secondTimestamp
        socket.send(JSON.stringify({ mt: 9, d: { '1': { mrk: 100, orl: 100, bid: 99, ask: 101, mid: 100, dv: 1, oi: 1, at: { t: timestamp } } } }))
        const orderBook = subscriptions.find(item => item.stream === 'order-book@1')
        if (orderBook) socket.send(JSON.stringify({ mt: 15, sid: orderBook.sid, at: { t: timestamp }, bid: [{ p: 99, s: 1, o: 1 }], ask: [{ p: 101, s: 1, o: 1 }] }))
        if (connection === 1) setTimeout(() => socket.close(), 50)
      })
    })
    try {
      await new Promise<void>(resolve => server.once('listening', () => resolve()))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('TEST_WS_ADDRESS_UNAVAILABLE')
      const stream = new PerplMarketStream(`ws://127.0.0.1:${address.port}`)
      try {
        await stream.ensure([1])
        const initial = await stream.snapshot(1, 1_000)
        expect(((initial?.market?.at as { t?: number } | undefined)?.t)).toBe(firstTimestamp)
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 5_000
          const poll = () => {
            void stream.snapshot(1, 50).then(state => {
              if (((state?.market?.at as { t?: number } | undefined)?.t) === secondTimestamp) resolve()
              else if (Date.now() >= deadline) reject(new Error('PERPL_STREAM_RECONNECT_TIMEOUT'))
              else setTimeout(poll, 100)
            })
          }
          poll()
        })
        const final = await stream.snapshot(1, 100)
        expect(((final?.market?.at as { t?: number } | undefined)?.t)).toBe(secondTimestamp)
      } finally {
        stream.close()
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }, 10_000)
})
