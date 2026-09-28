import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const port = await new Promise((resolve, reject) => {
  const listener = createServer()
  listener.once('error', reject)
  listener.listen(0, '127.0.0.1', () => {
    const address = listener.address()
    if (!address || typeof address === 'string') return reject(new Error('SMOKE_PORT_UNAVAILABLE'))
    listener.close(() => resolve(address.port))
  })
})

const child = spawn(process.execPath, ['dist/server/src/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, EYELER_ENV: 'test', EYELER_TEST_VENUE: 'false', DATABASE_URL: '', PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
child.stdout.on('data', chunk => { output += chunk.toString() })
child.stderr.on('data', chunk => { output += chunk.toString() })

try {
  let healthy = false
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.status === 200) { healthy = true; break }
    } catch { /* Server still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!healthy) throw new Error(`PRODUCTION_SMOKE_FAILED: ${output.slice(-500)}`)
  console.log('production smoke: /health 200')
} finally {
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3_000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}
