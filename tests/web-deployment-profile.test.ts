import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const buildScript = readFileSync(resolve('scripts/deploy/build-web.sh'), 'utf8')
const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')

describe('direct Railway web deployment profiles', () => {
  it('builds mainnet web against the isolated Singapore API, not the testnet alias', () => {
    expect(buildScript).toContain('api_url=https://api-mainnet-production-b042.up.railway.app')
    expect(workflow).toMatch(/Build live web app[\s\S]*?sh scripts\/deploy\/build-web\.sh mainnet/)
    expect(workflow).toContain('--dart-define=EYELER_API_URL=https://api-mainnet-production-b042.up.railway.app')
  })

  it('builds testnet web against the existing Railway testnet API', () => {
    expect(buildScript).toContain('api_url=https://api-production-9fcf.up.railway.app')
  })
})
