import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('Mera Android passkey association', () => {
  it('serves the release certificate for the exact package and RP domain', () => {
    const statements = JSON.parse(
      readFileSync(resolve(root, 'apps/mobile/web/.well-known/assetlinks.json'), 'utf8'),
    ) as Array<{ relation: string[]; target: Record<string, unknown> }>
    expect(statements).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
        target: {
          namespace: 'android_app',
          package_name: 'xyz.eyeler.app',
          sha256_cert_fingerprints: [
            '3B:5E:1E:84:90:F0:26:F8:09:5E:1B:F7:22:83:ED:AC:F2:25:3F:AF:2E:78:8E:F9:AA:4D:44:31:0E:F6:80:19',
          ],
        },
      },
    ])
    const hosting = JSON.parse(readFileSync(resolve(root, 'apps/mobile/web/vercel.json'), 'utf8')) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>
      rewrites?: unknown[]
      redirects?: unknown[]
    }
    expect(hosting.rewrites ?? []).toEqual([])
    expect(hosting.redirects ?? []).toEqual([])
    expect(hosting.headers.find((item) => item.source === '/.well-known/assetlinks.json')?.headers).toContainEqual({
      key: 'Content-Type',
      value: 'application/json',
    })
  })

  it('declares the RP asset statements in the Android app manifest', () => {
    const manifest = readFileSync(resolve(root, 'apps/mobile/android/app/src/main/AndroidManifest.xml'), 'utf8')
    const strings = readFileSync(resolve(root, 'apps/mobile/android/app/src/main/res/values/strings.xml'), 'utf8')
    expect(manifest).toContain('android:name="asset_statements" android:resource="@string/asset_statements"')
    expect(strings).toContain('https://app.eyeler.xyz/.well-known/assetlinks.json')
  })
})
