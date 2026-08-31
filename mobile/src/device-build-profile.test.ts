import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const easConfig = JSON.parse(
  readFileSync(new URL('../eas.json', import.meta.url).pathname, 'utf8'),
) as {
  build: Record<
    string,
    {
      developmentClient?: boolean
      distribution?: string
      env?: Record<string, string>
      extends?: string
    }
  >
}

test('the phone-delivery build is standalone and opens the live Nessie service', () => {
  const profile = easConfig.build.device

  assert.equal(profile.developmentClient, false)
  assert.equal(profile.distribution, 'internal')
  assert.equal(profile.env?.EXPO_PUBLIC_ADMIN_URL, 'https://app.nessie.works')
})

test('preview retains the standalone phone-delivery configuration', () => {
  assert.equal(easConfig.build.preview.extends, 'device')
})

test('Metro remains opt-in through the explicitly named development profile', () => {
  assert.equal(easConfig.build.development.developmentClient, true)
})
