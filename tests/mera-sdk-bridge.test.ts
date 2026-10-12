import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const bundle = readFileSync('apps/mobile/android/app/src/main/assets/mera-sdk.js', 'utf8')
const syntheticPrf = Uint8Array.from({ length: 32 }, (_, index) => index)
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

function harness() {
  const calls: Array<{ kind: string; request: Record<string, unknown> }> = []
  const completed: Record<string, unknown>[] = []
  const window: Record<string, any> = {}
  const native = {
    ready: () => undefined,
    request: (json: string) => {
      const { id, kind, request } = JSON.parse(json) as {
        id: string
        kind: string
        request: Record<string, unknown>
      }
      calls.push({ kind, request })
      window.eyelerMeraNativeResponse(
        id,
        JSON.stringify(
          kind === 'create'
            ? { credentialId: encode(Uint8Array.of(1, 2, 3)), prfEnabled: true }
            : { credentialId: encode(Uint8Array.of(1, 2, 3)), prfOutput: encode(syntheticPrf) },
        ),
      )
    },
    complete: (json: string) => completed.push(JSON.parse(json) as Record<string, unknown>),
  }
  runInNewContext(bundle, {
    window,
    EyelerMeraNative: native,
    crypto: webcrypto,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Promise,
  })
  return { calls, completed, window }
}

describe('bundled official Mera SDK bridge', () => {
  it('gets PRF through native ceremony with fixed RP and user verification', async () => {
    const { calls, completed, window } = harness()
    await window.eyelerMeraSdk.run('1', 'get', JSON.stringify({ rpId: 'app.eyeler.xyz' }))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.kind).toBe('get')
    expect(calls[0]?.request.rpId).toBe('app.eyeler.xyz')
    expect(calls[0]?.request.userVerification).toBe('required')
    expect(completed[0]?.prfOutput).toBe(encode(syntheticPrf))
  })

  it('creates a passkey and uses Mera fallback assertion for PRF', async () => {
    const { calls, completed, window } = harness()
    await window.eyelerMeraSdk.run('2', 'create', JSON.stringify({ rpId: 'app.eyeler.xyz', label: 'EYELER test' }))
    expect(calls.map(({ kind }) => kind)).toEqual(['create', 'get'])
    expect(calls[0]?.request.userVerification).toBe('required')
    expect(completed[0]?.credentialId).toBe(encode(Uint8Array.of(1, 2, 3)))
    expect(completed[0]?.prfOutput).toBe(encode(syntheticPrf))
  })

  it('rejects a different RP before asking Android for a passkey', async () => {
    const { calls, completed, window } = harness()
    await window.eyelerMeraSdk.run('3', 'get', JSON.stringify({ rpId: 'other.example' }))
    expect(calls).toHaveLength(0)
    expect(completed[0]?.error).toBe('MERA_FAILED')
  })
})
