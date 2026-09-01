import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { deriveNavigationLayout } from '../src/navigation/layout'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('the web decides by the md band alone', () => {
  const web = { reactNativeWebView: false, largePhoneLandscape: false, tabletMin: true }
  assert.equal(deriveNavigationLayout({ ...web, narrow: true }), 'single')
  assert.equal(deriveNavigationLayout({ ...web, narrow: false }), 'split')
})

test('the native shell decides by its named form factor, never by width alone', () => {
  const native = { reactNativeWebView: true, narrow: false }
  // A phone stays one stack however wide it reports.
  assert.equal(deriveNavigationLayout({ ...native, tabletMin: false, largePhoneLandscape: false }), 'single')
  // An iPad keeps its pinned column; squeezed into a narrow Split View it
  // drops to one stack.
  assert.equal(deriveNavigationLayout({ ...native, tabletMin: true, largePhoneLandscape: false }), 'split')
  assert.equal(
    deriveNavigationLayout({ ...native, narrow: true, tabletMin: false, largePhoneLandscape: false }),
    'single',
  )
  // A Max-class iPhone in landscape gets adjacent columns while it lasts.
  assert.equal(deriveNavigationLayout({ ...native, tabletMin: false, largePhoneLandscape: true }), 'split')
})

test('usePhoneLayout is only the single-layout reading of the one decision', () => {
  const shell = source('../src/lib/mobile-shell.ts')
  assert.match(shell, /export const usePhoneLayout = \(\): boolean => useNavigationLayout\(\) === 'single'/)
  assert.match(shell, /deriveNavigationLayout\(\{/)
  const layout = source('../src/layouts/AdminShellLayout.tsx')
  assert.match(layout, /const navigationLayout = useNavigationLayout\(\)/)
  assert.match(layout, /data-navigation=\{navigationLayout\}/)
})
