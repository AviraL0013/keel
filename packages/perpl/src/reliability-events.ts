import { EventEmitter } from 'node:events'

export type PerplReliabilityEvent = Readonly<{
  kind: 'websocket_disconnect' | 'websocket_ready' | 'websocket_reconnect'
  scope: 'trading' | 'market'
  streamId: string
  at: string
}>

const events = new EventEmitter()
type Listener = (event: PerplReliabilityEvent) => unknown

/** Observation cannot change transport behavior or expose private connection data. */
export function subscribePerplReliability(listener: Listener): () => void {
  const guarded = (event: PerplReliabilityEvent) => {
    try {
      const result = listener(event)
      if (result && typeof (result as PromiseLike<unknown>).then === 'function')
        void Promise.resolve(result).catch(() => undefined)
    } catch {
      // A failed observer must not block transport or other observers.
    }
  }
  events.on('transport', guarded)
  return () => events.off('transport', guarded)
}

/** Only enum names, opaque process-local stream identities and timestamps leave this module. */
export function emitPerplReliability(
  kind: PerplReliabilityEvent['kind'],
  scope: PerplReliabilityEvent['scope'],
  streamId: string,
) {
  if (
    !['websocket_disconnect', 'websocket_ready', 'websocket_reconnect'].includes(kind) ||
    !['trading', 'market'].includes(scope) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(streamId)
  )
    return
  const event: PerplReliabilityEvent = Object.freeze({ kind, scope, streamId, at: new Date().toISOString() })
  events.emit('transport', event)
}
