import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { deriveNavigationLayout } from '../src/navigation/layout'
import { surfaceScreen } from '../src/navigation/surfaces'
import {
  advancePhoneNavigationStack,
  createPhoneNavigationStack,
} from '../src/layouts/admin-shell/phone-navigation-stack'
import { getPhoneNavigationDirection } from '../src/layouts/admin-shell/phone-navigation'

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

test('on split, a root shares the stack floor with its details and in-parent nested rows collapse', () => {
  // The list column is the root, so a root and a detail are the same depth.
  assert.equal(surfaceScreen('/channels', 'split')?.depth, 1)
  assert.equal(surfaceScreen('/channels/c1', 'split')?.depth, 1)
  assert.equal(surfaceScreen('/channels', 'single')?.depth, 0)
  // The conversation renders its own info chain and reply thread on split.
  for (const nested of [
    '/channels/c1/info',
    '/channels/c1/info/members',
    '/channels/c1/info/members/add',
    '/channels/c1/threads/t1/replies/m1',
  ]) {
    assert.deepEqual(surfaceScreen(nested, 'split'), surfaceScreen('/channels/c1', 'split'), nested)
    assert.equal(surfaceScreen(nested, 'single')?.depth >= 2, true, nested)
  }
  assert.deepEqual(surfaceScreen('/settings/statuses/s1', 'split'), surfaceScreen('/settings/statuses', 'split'))
  // A nested screen with its own page still pushes inside the column.
  assert.equal(surfaceScreen('/agents/a1', 'split')?.depth, 2)
  assert.equal(surfaceScreen('/apps/slack', 'split')?.depth, 2)
})

test('on split, root → detail swaps in place and detail → nested pushes inside the column', () => {
  const root = createPhoneNavigationStack('/channels', 'root', 'split')
  const detail = advancePhoneNavigationStack(root, '/channels/c1', 'c1', 'split')
  assert.equal(detail.entries.length, 1, 'nothing is retained beneath a detail on split')
  assert.equal(getPhoneNavigationDirection('/channels', '/channels/c1', 'split'), null)
  assert.equal(getPhoneNavigationDirection('/channels/c1', '/channels/c1/info', 'split'), null)

  const agents = createPhoneNavigationStack('/agents', 'agents', 'split')
  const agent = advancePhoneNavigationStack(agents, '/agents/a1', 'a1', 'split')
  assert.equal(agent.entries.length, 2)
  assert.equal(agent.currentIndex, 1)
  assert.equal(getPhoneNavigationDirection('/agents', '/agents/a1', 'split'), 'forward')
  assert.equal(getPhoneNavigationDirection('/agents/a1', '/agents', 'split'), 'back')
  // The same routes on a phone keep their declared shape.
  assert.equal(getPhoneNavigationDirection('/channels', '/channels/c1'), 'forward')
})

test('the shell mounts the split stack in its detail column with no edge swipe', () => {
  const layout = source('../src/layouts/AdminShellLayout.tsx')
  assert.match(layout, /<PhoneNavigationViewport layout="split" pathname=\{shell\.pathname\}>/)
  const viewport = source('../src/layouts/admin-shell/PhoneNavigationViewport.tsx')
  assert.match(viewport, /enabled: layout === 'single' &&/)
})
