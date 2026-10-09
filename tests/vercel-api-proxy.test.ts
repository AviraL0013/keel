import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const config = JSON.parse(readFileSync(resolve('deploy/api-proxy/vercel.json'), 'utf8')) as {
  rewrites: { source: string; destination: string }[]
  headers: { source: string; headers: { key: string; value: string }[] }[]
}

describe('DNS staging API proxy', () => {
  it('keeps every API hostname on the existing testnet service before the DNS checkpoint', () => {
    expect(config.rewrites).toEqual([
      {
        source: '/:path*',
        destination: 'https://api-production-9fcf.up.railway.app/:path*',
      },
    ])
    expect(JSON.stringify(config)).not.toContain('api-mainnet-production')
  })

  it('does not cache API responses at the Vercel edge', () => {
    expect(config.headers).toEqual([
      {
        source: '/:path*',
        headers: [
          { key: 'x-vercel-enable-rewrite-caching', value: '0' },
          { key: 'Cache-Control', value: 'private, no-store' },
        ],
      },
    ])
  })
})
