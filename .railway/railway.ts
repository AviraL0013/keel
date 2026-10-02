import { defineRailway, github, project, service } from 'railway/iac'

// Own only these two services; existing databases and other services stay outside this partial.
export const partial = 'eyeler-backends'

const common = {
  source: github('AviraL0013/keel', { branch: 'main' }),
  build: { builder: 'DOCKERFILE' as const, dockerfilePath: 'Dockerfile' },
  deploy: {
    healthcheckPath: '/health',
    healthcheckTimeout: 120,
    numReplicas: 1,
    overlapSeconds: 0,
    drainingSeconds: 30,
    restartPolicyType: 'ON_FAILURE' as const,
    restartPolicyMaxRetries: 10,
  },
}

export default defineRailway(() => {
  const api = service('api', {
    ...common,
    deploy: { ...common.deploy, preDeployCommand: ['node dist/scripts/migrate.js'] },
    env: { EYELER_ENV: 'testnet' },
  })
  const sandbox = service('sandbox-api', {
    ...common,
    env: { EYELER_ENV: 'test', EYELER_TEST_VENUE: 'true' },
  })
  return project('eyeler', { resources: [api, sandbox] })
})
