import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('Organization settings no longer offers a separate Channels destination', () => {
  const navigation = readSource('../src/layouts/admin-shell/AdminSidebarNav.tsx')

  assert.doesNotMatch(navigation, /path: '\/settings\/channels'/)
})

test('the separate settings Channels route and page are removed', () => {
  const router = readSource('../src/router.tsx')

  assert.doesNotMatch(router, /path: '\/settings\/channels'/)
  assert.doesNotMatch(router, /SettingsChannelsPage/)
})
