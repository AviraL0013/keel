import type { EventEmitter } from 'node:events'
import { logger } from './config/index.js'

type ClosableServer = { close(): Promise<void> }

export async function shutdownServer(server: ClosableServer, timeoutMs = 30_000, onTimeout: () => void = () => process.exit(1)) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      server.close(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        try { onTimeout() } finally { reject(new Error('SHUTDOWN_TIMEOUT')) }
      }, timeoutMs) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

export function installShutdownHandlers(server: ClosableServer, signals: Pick<EventEmitter, 'once' | 'off'> = process, timeoutMs = 30_000, onTimeout: () => void = () => process.exit(1)) {
  let closing: Promise<void> | undefined
  const shutdown = () => {
    if (closing) return
    closing = shutdownServer(server, timeoutMs, onTimeout).catch(error => {
      logger.error({ error: error instanceof Error ? error.message : 'SHUTDOWN_FAILED' }, 'KEEL shutdown failed')
      process.exitCode = 1
    })
  }
  signals.once('SIGTERM', shutdown)
  signals.once('SIGINT', shutdown)
  return () => { signals.off('SIGTERM', shutdown); signals.off('SIGINT', shutdown); return closing ?? Promise.resolve() }
}
