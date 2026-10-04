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

const preserveExisting = (names: string[]) =>
  Object.fromEntries(names.map((name) => [name, { preserveExisting: true }]))

const apiVariables = {
  ...preserveExisting([
    'DATABASE_URL',
    'SESSION_SECRET',
    'EYELER_ALLOWED_WALLETS',
    'CORS_ORIGIN',
    'EYELER_APP_URL',
    'PERPL_REST_URL',
    'PERPL_WS_URL',
    'PERPL_CHAIN_ID',
    'PERPL_API_KEY',
    'PERPL_API_KEY_SECRET',
    'PERPL_ACCOUNT_ID',
    'MONAD_RPC_URL',
    'MONAD_CHAIN_ID',
    'AUSD_TOKEN_ADDRESS',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
  ]),
  EYELER_ENV: 'testnet',
}

const sandboxVariables = {
  ...preserveExisting(['SESSION_SECRET', 'CORS_ORIGIN', 'EYELER_APP_URL']),
  EYELER_ENV: 'test',
  EYELER_TEST_VENUE: 'true',
}

export default defineRailway(() => {
  const api = service('api', {
    ...common,
    deploy: { ...common.deploy, region: 'sin', preDeployCommand: ['node dist/scripts/migrate.js'] },
    env: apiVariables,
  })
  const sandbox = service('sandbox-api', {
    ...common,
    env: sandboxVariables,
  })
  return project('eyeler', { resources: [api, sandbox] })
})
