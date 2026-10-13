export type WalletHttp451Diagnostic = {
  status: 451
  contentKind: 'json' | 'html' | 'text' | 'other' | 'unknown'
  edgeProvider: 'cloudflare' | 'cloudfront' | 'fastly' | 'akamai' | 'envoy' | 'nginx' | 'unknown'
  redirectOriginSame: boolean | null
  bodyComplete: boolean
  bodyReadTimedOut: boolean
  legal: boolean
  region: boolean
  origin: boolean
  authentication: boolean
  rateLimit: boolean
  waf: boolean
}
export type WalletHttp451DiagnosticHandler = (diagnostic: WalletHttp451Diagnostic) => void | Promise<void>

/** Inspect only the existing denied response. No response text or identifying metadata leaves this helper. */
export async function reportWalletHttp451(
  response: Response,
  expectedOrigin: string,
  callback: WalletHttp451DiagnosticHandler,
): Promise<void> {
  const diagnostic: WalletHttp451Diagnostic = {
    status: 451,
    contentKind: 'unknown',
    edgeProvider: 'unknown',
    redirectOriginSame: null,
    bodyComplete: false,
    bodyReadTimedOut: false,
    legal: false,
    region: false,
    origin: false,
    authentication: false,
    rateLimit: false,
    waf: false,
  }
  try {
    const contentType = response.headers.get('content-type')?.toLowerCase()
    diagnostic.contentKind = !contentType
      ? 'unknown'
      : contentType.includes('json')
        ? 'json'
        : contentType.includes('html')
          ? 'html'
          : contentType.startsWith('text/')
            ? 'text'
            : 'other'
    const provider = `${response.headers.get('server') ?? ''} ${response.headers.get('via') ?? ''}`.toLowerCase()
    for (const name of ['cloudflare', 'cloudfront', 'fastly', 'akamai', 'envoy', 'nginx'] as const) {
      if (provider.includes(name)) {
        diagnostic.edgeProvider = name
        break
      }
    }
    if (response.url) diagnostic.redirectOriginSame = new URL(response.url).origin === expectedOrigin
  } catch {
    // Malformed metadata cannot change the original HTTP error.
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading = true
  const bytes = new Uint8Array(4096)
  let length = 0
  try {
    if (!response.body) {
      diagnostic.bodyComplete = true
    } else {
      reader = response.body.getReader()
      await Promise.race([
        (async () => {
          // A chunk-count cap also bounds streams emitting empty or tiny chunks.
          for (let chunks = 0; chunks < 64 && length < bytes.length; chunks++) {
            const { done, value } = await reader!.read()
            if (!reading) return
            if (done) {
              diagnostic.bodyComplete = true
              return
            }
            if (!(value instanceof Uint8Array)) return
            const count = Math.min(value.length, bytes.length - length)
            bytes.set(value.subarray(0, count), length)
            length += count
          }
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            diagnostic.bodyReadTimedOut = true
            resolve()
          }, 750)
        }),
      ])
    }
  } catch {
    // Stream errors remain diagnostic omissions, never replacement errors.
  } finally {
    reading = false
    if (timer) clearTimeout(timer)
    if (reader) {
      if (!diagnostic.bodyComplete) {
        try {
          // Do not wait for a stalled cancellation acknowledgement.
          void reader.cancel().catch(() => undefined)
        } catch {
          // A failed cancellation cannot mask HTTP 451.
        }
      }
      try {
        reader.releaseLock()
      } catch {
        // A pending read may retain its lock until cancellation completes.
      }
    }
  }
  const text = new TextDecoder().decode(bytes.subarray(0, length)).toLowerCase()
  diagnostic.legal = /legal|jurisdiction|regulat|sanction|applicable law/.test(text)
  diagnostic.region = /countr(?:y|ies)|region|geograph|geolocation|territor/.test(text)
  diagnostic.origin = /origin|referer|referrer|cors/.test(text)
  diagnostic.authentication = /authenticat|unauthori[sz]ed|signature|credential|api[ _-]?key|nonce|token expired/.test(
    text,
  )
  diagnostic.rateLimit = /rate[ _-]?limit|too many requests|throttl/.test(text)
  diagnostic.waf = /\bwaf\b|web application firewall|bot challenge|cloudflare challenge/.test(text)
  bytes.fill(0)

  let callbackTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => callback(diagnostic)),
      new Promise<void>((resolve) => {
        callbackTimer = setTimeout(resolve, 100)
      }),
    ])
  } catch {
    // Diagnostic consumers must never change the original HTTP error.
  } finally {
    if (callbackTimer) clearTimeout(callbackTimer)
  }
}
