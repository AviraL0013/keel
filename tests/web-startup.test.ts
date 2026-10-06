import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

describe('Flutter web startup', () => {
  it('loads the passkeys SDK before Flutter registers its web plugin', () => {
    const web = resolve('apps/mobile/web')
    const html = readFileSync(resolve(web, 'index.html'), 'utf8')
    const passkeysScript = '<script src="vendor/passkeys/bundle.js"></script>'
    const bootstrapScript = '<script src="flutter_bootstrap.js" async></script>'

    expect(html.indexOf(passkeysScript)).toBeGreaterThan(-1)
    expect(html.indexOf(passkeysScript)).toBeLessThan(html.indexOf(bootstrapScript))
    const context = {} as { PasskeyAuthenticator?: { init: () => void } }
    runInNewContext(readFileSync(resolve(web, 'vendor/passkeys/bundle.js'), 'utf8'), context)
    expect(context.PasskeyAuthenticator?.init).toBeTypeOf('function')
    expect(() => context.PasskeyAuthenticator?.init()).not.toThrow()
  })
})
