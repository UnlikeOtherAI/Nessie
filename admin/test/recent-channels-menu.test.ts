import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('recent channel labels truncate inside a viewport-bounded menu', () => {
  const menu = readSource('../src/layouts/admin-shell/topbar-navigation.tsx')
  const styles = readSource('../src/styles.css')

  assert.match(menu, /className="min-w-0 flex-1 truncate">\{channel\.label\}<\/span>/)
  assert.match(styles, /\.admin-topbar-menu\s*\{[^}]*width:\s*min\(320px, calc\(100vw - 24px\)\);/s)
})
