import { afterEach, describe, expect, it, vi } from 'vitest'
import { PerplHistory, type WalletHttp451DiagnosticHandler } from '../packages/perpl/src/history.js'

const privateSentinel = 'SECRET_SENTINEL_DO_NOT_EMIT'
const signer = () => ({ apiKey: 'fixture-key', sign: vi.fn().mockResolvedValue('fixture-signature') })
const history = (response: Response, callback?: WalletHttp451DiagnosticHandler) =>
  new PerplHistory(
    'https://app.perpl.xyz/api',
    signer(),
    vi.fn().mockResolvedValue(response),
    undefined,
    undefined,
    callback,
  )

afterEach(() => vi.useRealTimers())

describe('bounded wallet HTTP 451 diagnostics', () => {
  it('reports fixed country/legal categories and content/provider enums without raw content', async () => {
    const callback = vi.fn()
    const response = new Response(`<html>Unavailable for legal reasons in your country. ${privateSentinel}</html>`, {
      status: 451,
      headers: { 'content-type': 'text/html', server: 'cloudflare', 'cf-ray': privateSentinel },
    })
    await expect(history(response, callback).wallet()).rejects.toThrow('PERPL_WALLET_HTTP_451')
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({
      status: 451,
      contentKind: 'html',
      edgeProvider: 'cloudflare',
      redirectOriginSame: null,
      bodyComplete: true,
      bodyReadTimedOut: false,
      legal: true,
      region: true,
      origin: false,
      authentication: false,
      rateLimit: false,
      waf: false,
    })
    expect(JSON.stringify(callback.mock.calls)).not.toContain(privateSentinel)
  })

  it('classifies JSON authentication denial and origin without publishing response fields', async () => {
    const callback = vi.fn()
    const response = new Response(
      JSON.stringify({ error: 'Authentication denied; origin forbidden', api_key: privateSentinel }),
      { status: 451, headers: { 'content-type': 'application/json', server: privateSentinel } },
    )
    Object.defineProperty(response, 'url', { value: `https://app.perpl.xyz/api/v1/trading/wallet?${privateSentinel}` })
    await expect(history(response, callback).wallet()).rejects.toThrow('PERPL_WALLET_HTTP_451')
    expect(callback.mock.calls[0][0]).toMatchObject({
      contentKind: 'json',
      edgeProvider: 'unknown',
      redirectOriginSame: true,
      authentication: true,
      origin: true,
      legal: false,
      region: false,
    })
    expect(JSON.stringify(callback.mock.calls)).not.toContain(privateSentinel)
  })

  it('keeps default behavior immediate and never reads the body without callback', async () => {
    const getReader = vi.fn(() => {
      throw new Error(privateSentinel)
    })
    const response = { ok: false, status: 451, body: { getReader } } as unknown as Response
    await expect(history(response).wallet()).rejects.toThrow('PERPL_WALLET_HTTP_451')
    expect(getReader).not.toHaveBeenCalled()
  })

  it('leaves other HTTP status behavior unchanged and does not inspect its body', async () => {
    const callback = vi.fn()
    const getReader = vi.fn()
    const response = { ok: false, status: 401, body: { getReader } } as unknown as Response
    await expect(history(response, callback).wallet()).rejects.toThrow('PERPL_WALLET_HTTP_401')
    expect(callback).not.toHaveBeenCalled()
    expect(getReader).not.toHaveBeenCalled()
  })

  it('keeps exact signed target and existing request headers unchanged', async () => {
    const key = signer()
    const transport = vi.fn().mockResolvedValue(new Response('WAF rate limit', { status: 451 }))
    const callback = vi.fn()
    const value = new PerplHistory('https://app.perpl.xyz/api', key, transport, undefined, undefined, callback)
    await expect(value.wallet()).rejects.toThrow('PERPL_WALLET_HTTP_451')
    const [, target, body, timestamp, nonce] = key.sign.mock.calls[0]
    expect(key.sign).toHaveBeenCalledOnce()
    expect(key.sign.mock.calls[0].slice(0, 3)).toEqual(['GET', '/v1/trading/wallet', ''])
    expect(timestamp).toMatch(/^\d+$/)
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(target).toBe('/v1/trading/wallet')
    expect(body).toBe('')
    expect(transport).toHaveBeenCalledExactlyOnceWith('https://app.perpl.xyz/api/v1/trading/wallet', {
      signal: expect.any(AbortSignal),
      headers: {
        'X-API-Key': 'fixture-key',
        'X-API-Timestamp': timestamp,
        'X-API-Nonce': nonce,
        'X-API-Signature': 'fixture-signature',
      },
    })
    expect(callback.mock.calls[0][0]).toMatchObject({ rateLimit: true, waf: true })
  })

  it('limits oversized chunks to 4096 bytes and cancels the reader', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('country ' + 'x'.repeat(6000) + ' authentication'))
      },
      cancel,
    })
    const callback = vi.fn()
    await expect(history(new Response(stream, { status: 451 }), callback).wallet()).rejects.toThrow(
      'PERPL_WALLET_HTTP_451',
    )
    expect(callback.mock.calls[0][0]).toMatchObject({ region: true, authentication: false, bodyComplete: false })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('bounds many streaming chunks and cancels without reading the whole stream', async () => {
    let pulls = 0
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(512).fill(120))
      },
      cancel,
    })
    const callback = vi.fn()
    await expect(history(new Response(stream, { status: 451 }), callback).wallet()).rejects.toThrow(
      'PERPL_WALLET_HTTP_451',
    )
    expect(pulls).toBeLessThanOrEqual(10)
    expect(cancel).toHaveBeenCalledOnce()
    expect(callback.mock.calls[0][0]).toMatchObject({ bodyComplete: false, bodyReadTimedOut: false })
  })

  it('times out hanging body at 750ms, cancels, and preserves original error', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const stream = new ReadableStream<Uint8Array>({ cancel })
    const callback = vi.fn()
    const result = expect(history(new Response(stream, { status: 451 }), callback).wallet()).rejects.toThrow(
      'PERPL_WALLET_HTTP_451',
    )
    await vi.advanceTimersByTimeAsync(750)
    await result
    expect(cancel).toHaveBeenCalledOnce()
    expect(callback.mock.calls[0][0]).toMatchObject({ bodyComplete: false, bodyReadTimedOut: true })
  })

  it('ignores callback exceptions without changing HTTP status error', async () => {
    const callback = vi.fn(() => {
      throw new Error(privateSentinel)
    })
    await expect(history(new Response('denied', { status: 451 }), callback).wallet()).rejects.toThrow(
      'PERPL_WALLET_HTTP_451',
    )
    expect(callback).toHaveBeenCalledOnce()
  })

  it('times out hanging callback at 100ms without masking HTTP status', async () => {
    vi.useFakeTimers()
    const callback = vi.fn(() => new Promise<void>(() => {}))
    const result = expect(history(new Response('denied', { status: 451 }), callback).wallet()).rejects.toThrow(
      'PERPL_WALLET_HTTP_451',
    )
    await vi.advanceTimersByTimeAsync(100)
    await result
    expect(callback).toHaveBeenCalledOnce()
  })

  it('reports different redirect origin only as boolean, never its URL', async () => {
    const callback = vi.fn()
    const response = new Response('denied', { status: 451 })
    Object.defineProperty(response, 'url', { value: `https://blocked.example/${privateSentinel}` })
    await expect(history(response, callback).wallet()).rejects.toThrow('PERPL_WALLET_HTTP_451')
    expect(callback.mock.calls[0][0].redirectOriginSame).toBe(false)
    expect(JSON.stringify(callback.mock.calls)).not.toContain('blocked.example')
    expect(JSON.stringify(callback.mock.calls)).not.toContain(privateSentinel)
  })

  it('ignores body stream failures and never exposes their error text', async () => {
    const callback = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(privateSentinel))
      },
    })
    await expect(history(new Response(stream, { status: 451 }), callback).wallet()).rejects.toThrow(
      'PERPL_WALLET_HTTP_451',
    )
    expect(callback.mock.calls[0][0]).toMatchObject({ bodyComplete: false, bodyReadTimedOut: false })
    expect(JSON.stringify(callback.mock.calls)).not.toContain(privateSentinel)
  })
})
