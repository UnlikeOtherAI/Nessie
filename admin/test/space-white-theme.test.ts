import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const source = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

test('Space White is registered and used for a new light session', () => {
  const provider = source('../src/providers/ThemeProvider.tsx')
  const firstPaint = source('../index.html')

  assert.match(provider, /\| 'space-white'/)
  assert.match(provider, /id: 'space-white',[\s\S]*?label: 'Space White'/)
  assert.match(provider, /serverTheme \?\? getLocalTheme\(\) \?\? 'space-white'/)
  assert.match(firstPaint, /: 'space-white'/)
  assert.match(firstPaint, /\? 'space-white' : t/)
})

test('Space White owns the shared product geometry instead of route-local copies', () => {
  const styles = source('../src/styles.css')
  const spaceWhite = styles.slice(styles.indexOf("[data-theme='space-white'] .admin-topbar"))

  assert.match(styles, /\[data-theme="space-white"\]\s*\{[\s\S]*?--accent: #000000/)
  assert.match(styles, /--font-family-display: 'Starleague'/)
  assert.match(spaceWhite, /\.admin-page-action\s*\{[\s\S]*?border-radius: 7px/)
  assert.match(spaceWhite, /\.admin-input\s*\{[\s\S]*?min-height: 44px[\s\S]*?border-radius: 14px/)
  assert.match(spaceWhite, /\.admin-card\s*\{[\s\S]*?border-radius: 20px/)
  assert.match(spaceWhite, /\.create-channel-panel\s*\{[\s\S]*?border-radius: 28px/)
  assert.match(spaceWhite, /\.admin-compose\s*\{[\s\S]*?border-radius: 14px/)
  assert.match(spaceWhite, /\.tabbar-indicator\s*\{[\s\S]*?height: 2px/)
})

test('the supplied Starleague face and its license ship with the admin', () => {
  assert.equal(
    existsSync(new URL('../src/assets/fonts/starleague-regular.ttf', import.meta.url)),
    true,
  )
  assert.equal(
    existsSync(new URL('../src/assets/fonts/STARLEAGUE-LICENSE.txt', import.meta.url)),
    true,
  )
})
