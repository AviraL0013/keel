import type { WalletHttp451Diagnostic, WalletHttp451DiagnosticHandler } from '../../../../packages/perpl/src/history.js'
import { logger } from '../../config/index.js'

type Source = 'account-state' | 'account-discovery' | 'runtime-history'
type Sink = { warn: (record: unknown, message: string) => void }
const lastEmission = new Map<Source, number>()
const contentKinds = new Set(['json', 'html', 'text', 'other', 'unknown'])
const edgeProviders = new Set(['cloudflare', 'cloudfront', 'fastly', 'akamai', 'envoy', 'nginx', 'unknown'])

/** Error classification only. Never log response text, headers, identifiers or credentials. */
export function createPerplWalletDenialReporter(
  source: Source,
  options: { sink?: Sink; now?: () => number; lastEmission?: Map<Source, number> } = {},
): WalletHttp451DiagnosticHandler {
  const sink = options.sink ?? logger
  const now = options.now ?? Date.now
  const seen = options.lastEmission ?? lastEmission
  return (value: WalletHttp451Diagnostic) => {
    if (value.status !== 451) return
    const stamp = now()
    const previous = seen.get(source)
    if (!Number.isFinite(stamp) || (previous !== undefined && stamp - previous < 60_000)) return
    seen.set(source, stamp)
    // Project again at the log boundary, so unexpected fields cannot escape.
    const diagnostic = {
      status: 451,
      contentKind: contentKinds.has(value.contentKind) ? value.contentKind : 'unknown',
      edgeProvider: edgeProviders.has(value.edgeProvider) ? value.edgeProvider : 'unknown',
      redirectOriginSame: typeof value.redirectOriginSame === 'boolean' ? value.redirectOriginSame : null,
      bodyComplete: value.bodyComplete === true,
      bodyReadTimedOut: value.bodyReadTimedOut === true,
      legal: value.legal === true,
      region: value.region === true,
      origin: value.origin === true,
      authentication: value.authentication === true,
      rateLimit: value.rateLimit === true,
      waf: value.waf === true,
    }
    try {
      sink.warn({ source, diagnostic }, 'PERPL_WALLET_DENIAL')
    } catch {
      // Diagnostics must never replace the original upstream failure.
    }
  }
}
