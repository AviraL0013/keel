import { describe, expect, it } from 'vitest'
import {
  RailwayEnvelopeKeyCustody,
  RailwayTestnetKeyCustody,
} from '../server/src/infrastructure/perpl/railway-testnet-key-custody.js'

describe('Railway testnet envelope custody', () => {
  const key1 = '11'.repeat(32)
  const key2 = '22'.repeat(32)
  const alice = { userId: 'alice', credentialId: 'connection-a:api_token' }
  const bob = { userId: 'bob', credentialId: 'connection-b:api_token' }

  it('seals with a random data key and rejects a credential swapped between users', async () => {
    const custody = new RailwayTestnetKeyCustody({ v1: key1 }, 'v1')
    const first = await custody.seal('token', alice)
    const second = await custody.seal('token', alice)
    expect(first).not.toBe(second)
    expect(await custody.open(first, alice)).toBe('token')
    await expect(custody.open(first, bob)).rejects.toThrow('CREDENTIAL_DECRYPT_FAILED')
  })

  it('rotates without losing old rows while the prior wrapping key remains configured', async () => {
    const original = new RailwayTestnetKeyCustody({ v1: key1 }, 'v1')
    const old = await original.seal('token', alice)
    const upgraded = new RailwayTestnetKeyCustody({ v1: key1, v2: key2 }, 'v2')
    expect(await upgraded.open(old, alice)).toBe('token')
    const rotated = await upgraded.rotate(old, alice)
    expect(await upgraded.open(rotated, alice)).toBe('token')
    await expect(new RailwayTestnetKeyCustody({ v2: key2 }, 'v2').open(old, alice)).rejects.toThrow(
      'CREDENTIAL_DECRYPT_FAILED',
    )
    expect(await new RailwayTestnetKeyCustody({ v2: key2 }, 'v2').open(rotated, alice)).toBe('token')
  })
})

describe('Railway allowlist demo custody', () => {
  const alice = { userId: 'alice', credentialId: 'connection-a:api_token' }
  const bob = { userId: 'bob', credentialId: 'connection-b:api_token' }
  it('binds mainnet ciphertext to user, credential and environment', async () => {
    const demo = new RailwayEnvelopeKeyCustody({ v1: '11'.repeat(32) }, 'v1', 'mainnet')
    const sealed = await demo.seal('token', alice)
    expect(await demo.open(sealed, alice)).toBe('token')
    await expect(demo.open(sealed, bob)).rejects.toThrow('CREDENTIAL_DECRYPT_FAILED')
    await expect(new RailwayTestnetKeyCustody({ v1: '11'.repeat(32) }, 'v1').open(sealed, alice)).rejects.toThrow(
      'CREDENTIAL_DECRYPT_FAILED',
    )
  })
  it('keeps old rows readable during wrapping-key rotation', async () => {
    const original = new RailwayEnvelopeKeyCustody({ v1: '11'.repeat(32) }, 'v1', 'mainnet')
    const old = await original.seal('token', alice)
    const next = new RailwayEnvelopeKeyCustody({ v1: '11'.repeat(32), v2: '22'.repeat(32) }, 'v2', 'mainnet')
    expect(await next.open(old, alice)).toBe('token')
    const rotated = await next.rotate(old, alice)
    expect(await new RailwayEnvelopeKeyCustody({ v2: '22'.repeat(32) }, 'v2', 'mainnet').open(rotated, alice)).toBe(
      'token',
    )
  })
})
