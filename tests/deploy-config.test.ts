import { describe, expect, it } from 'vitest'
import { createRailwayContext } from 'railway/iac'
import railway, { partial } from '../.railway/railway.js'
import { checkNames, namesFromEnv, namesFromRailway } from '../scripts/deploy/check-env.mjs'

describe('deployment configuration', () => {
  it('keeps one non-overlapping Dockerfile replica per backend', async () => {
    const configuration = await railway(createRailwayContext({ environment: 'production' }))
    expect(partial).toBe('eyeler-backends')
    expect(configuration.resources).toHaveLength(2)
    for (const backend of configuration.resources) {
      expect(backend.build).toMatchObject({ builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' })
      expect(backend.deploy).toMatchObject({
        numReplicas: 1,
        overlapSeconds: 0,
        healthcheckPath: '/health',
        restartPolicyType: 'ON_FAILURE',
      })
    }
    expect(configuration.resources[0].deploy.preDeployCommand).toEqual(['node dist/scripts/migrate.js'])
    expect(configuration.resources[1].deploy.preDeployCommand).toBeUndefined()
  })

  it('checks only variable names from env or Railway JSON', () => {
    const env = namesFromEnv('SESSION_SECRET=hidden\nEYELER_ENV=test\nEYELER_TEST_VENUE=true\n')
    expect(checkNames('sandbox', env)).toEqual([])
    expect(
      checkNames(
        'sandbox',
        namesFromRailway('{"SESSION_SECRET":"hidden","EYELER_ENV":"test","EYELER_TEST_VENUE":"true"}'),
      ),
    ).toEqual([])
    expect(checkNames('testnet', env)).toContain('DATABASE_URL')
    expect(() => namesFromRailway('[]')).toThrow('INVALID_RAILWAY_JSON')
    expect(() => checkNames('mainnet', env)).toThrow('INVALID_TARGET')
  })
})
