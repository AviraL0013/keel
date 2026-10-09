import { describe, expect, it, vi } from 'vitest'
import { assertProductionConfig, loadConfig } from '../packages/shared/src/index.js'
import {
  createRailwayClient,
  planMainnetVariables,
  prepareMainnetRailway,
  railwayArguments,
  railwayLaunch,
  validateTarget,
} from '../scripts/deploy/prepare-mainnet-railway.mjs'

const target = {
  service: 'api-mainnet',
  environment: 'production',
  project: '11111111-2222-4333-8444-555555555555',
  wallet: '0x335E58172fC8895Bc380471972A22Ea921152F6d',
  apply: true,
}

describe('mainnet Railway preparation without production calls', () => {
  it('requires a separate mainnet service, an explicit UUID project and one public wallet', () => {
    expect(() => validateTarget({ ...target, service: 'api' })).toThrow('SEPARATE_MAINNET_SERVICE_REQUIRED')
    expect(() => validateTarget({ ...target, environment: 'staging' })).toThrow('PRODUCTION_ENVIRONMENT_REQUIRED')
    expect(() => validateTarget({ ...target, project: '------------------------------------' })).toThrow(
      'EXPLICIT_RAILWAY_PROJECT_REQUIRED',
    )
    expect(() => planMainnetVariables('not-an-address')).toThrow('INVALID_PUBLIC_WALLET_ADDRESS')
    expect(planMainnetVariables(target.wallet)).toMatchObject({
      EYELER_ENV: 'mainnet',
      EYELER_PERPL_ACCOUNT_MODE: 'per-user',
      EYELER_ACCESS_MODE: 'allowlist',
      EYELER_OPENING_ENABLED: 'false',
      EYELER_EXECUTION_DISABLED: 'true',
      EYELER_STRATEGIES_LIVE_ENABLED: 'false',
      EYELER_BUILDER_ID: '25',
      EYELER_MAX_BUILDER_FEE_PER_100K: '0',
    })
    const env = {
      ...planMainnetVariables(target.wallet),
      DATABASE_URL: 'postgres://fixture-mainnet-only',
      SESSION_SECRET: 'fixture-session-secret-never-deploy',
      EYELER_DEMO_CUSTODY_KEYS: JSON.stringify({ v1: '11'.repeat(32) }),
    }
    expect(() => assertProductionConfig(loadConfig(env), env)).not.toThrow()
  })

  it('does nothing on a dry run or when shared and target names already exist', async () => {
    const random = vi.fn(() => Buffer.alloc(48))
    const client = { listNames: vi.fn(), setPublic: vi.fn(), setSecret: vi.fn() }
    expect(await prepareMainnetRailway({ ...target, apply: false }, client, random)).toMatchObject({ applied: false })
    expect(client.listNames).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
    client.listNames.mockResolvedValueOnce(new Set(['PERPL_API_KEY']))
    await expect(prepareMainnetRailway(target, client, random)).rejects.toThrow('FORBIDDEN_SHARED_VARIABLE_NAMES')
    client.listNames.mockResolvedValueOnce(new Set(['SESSION_SECRET']))
    await expect(prepareMainnetRailway(target, client, random)).rejects.toThrow('VARIABLE_NAMES_ALREADY_PRESENT')
    expect(client.setPublic).not.toHaveBeenCalled()
    expect(client.setSecret).not.toHaveBeenCalled()
  })

  it('pipes generated credentials through stdin and never places them in command arguments', async () => {
    const calls: Array<{ args: string[]; input?: string }> = []
    const client = createRailwayClient(target, async (args: string[], input?: string) => {
      calls.push({ args, input })
      return args[1] === 'list' ? JSON.stringify({ DATABASE_URL: 'never-printed' }) : ''
    })
    const result = await prepareMainnetRailway(target, client, (bytes: number) => Buffer.alloc(bytes, 0x11))
    expect(result.applied).toBe(true)
    const secretCalls = calls.filter((call) => call.args.includes('--stdin'))
    expect(secretCalls).toHaveLength(2)
    expect(secretCalls.map((call) => call.args[2])).toEqual(['SESSION_SECRET', 'EYELER_DEMO_CUSTODY_KEYS'])
    expect(secretCalls.every((call) => call.args.includes('--skip-deploys'))).toBe(true)
    for (const call of secretCalls) {
      expect(call.input).toBeTruthy()
      expect(call.args.join(' ')).not.toContain(call.input)
    }
    expect(JSON.parse(secretCalls[1].input!)).toHaveProperty('v1')
    expect(railwayArguments(target, 'SESSION_SECRET')).toContain('--stdin')
  })

  it('launches the Windows Railway CLI through Node without a shell', () => {
    const launch = railwayLaunch(['variable', 'list'], 'win32', { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' })
    expect(launch.command).toBe(process.execPath)
    expect(launch.args[0]).toMatch(/npm[\\/]node_modules[\\/]@railway[\\/]cli[\\/]bin[\\/]railway\.js$/)
    expect(launch.args.slice(1)).toEqual(['variable', 'list'])
    expect(railwayLaunch(['variable', 'list'], 'linux', {}).command).toBe('railway')
  })

  it('reports only names after a partial CLI failure, never generated values', async () => {
    const client = {
      listNames: async () => new Set<string>(),
      setPublic: async () => undefined,
      setSecret: async () => {
        throw new Error('synthetic key material must not surface')
      },
    }
    await expect(prepareMainnetRailway(target, client, () => Buffer.alloc(48, 0x11))).rejects.toThrow(
      'RAILWAY_PREPARATION_INCOMPLETE_AFTER_NAMES',
    )
  })
})
