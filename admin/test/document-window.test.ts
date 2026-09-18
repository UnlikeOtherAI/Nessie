import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  documentWindowPath,
  openDocumentWindow,
  opensDocumentsInTheirOwnWindow,
} from '../src/lib/document-window'

/**
 * A double-tap on the desktop opens the document in a window of its own. Three
 * separate places have to agree on where that window points — the Rust that
 * builds it, the admin helper that names it, and the router that answers it —
 * and they are in two languages, so nothing but a test can hold them together.
 */

const readRepoFile = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const withWindow = <Result>(fake: unknown, body: () => Result): Result => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fake, writable: true })
  try {
    return body()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else delete (globalThis as { window?: unknown }).window
  }
}

test('the window points at the document route, with its ids escaped', () => {
  assert.equal(documentWindowPath('space1', 'page1'), '/documents/space1/page1')
  assert.equal(documentWindowPath('a/b', 'c d'), '/documents/a%2Fb/c%20d')
})

test('only the desktop shell opens a document in its own window', () => {
  assert.equal(withWindow(undefined, opensDocumentsInTheirOwnWindow), false)
  assert.equal(withWindow({}, opensDocumentsInTheirOwnWindow), false)
  assert.equal(
    withWindow({ __nessieDesktopPlatform: 'windows' }, opensDocumentsInTheirOwnWindow),
    true,
  )
  assert.equal(withWindow({ __TAURI_INTERNALS__: {} }, opensDocumentsInTheirOwnWindow), true)
})

test('a browser answers no rather than reaching for a shell that is not there', async () => {
  // The caller opens the document in place on `false`. Throwing here instead
  // would make a double-tap in a browser tab do nothing at all.
  assert.equal(await withWindow({}, () => openDocumentWindow({
    pageId: 'page1',
    spaceId: 'space1',
    title: 'Quarterly plan',
  })), false)
})

test('the shell, the admin helper and the router name the same route', () => {
  const rust = readRepoFile('../../desktop/src-tauri/src/document_window.rs')
  const router = readRepoFile('../src/router.tsx')
  const surfaces = readRepoFile('../src/navigation/surfaces.ts')

  // The Rust pastes the ids straight into this path; the helper above builds
  // the same one. A rename on either side without the other opens a window on
  // the admin's not-found screen.
  assert.match(rust, /"\/documents\/\{space_id\}\/\{page_id\}"/)
  assert.match(router, /path: '\/documents\/:spaceId\/:pageId'/)
  // Outside the navigation stack, and declared as such: a window holding one
  // document has no section to light and no Back to return to.
  assert.match(surfaces, /'\/documents\/:spaceId\/:pageId'/)
  // The route must stay out of the admin shell, or every document window
  // would open a second sidebar, rail and tab bar.
  const routeAt = router.indexOf("path: '/documents/:spaceId/:pageId'")
  const shellAt = router.indexOf('element: <AdminShellLayout />')
  assert.ok(routeAt > 0 && shellAt > 0 && routeAt < shellAt)
})

test('the shell refuses an id it would have to escape', () => {
  const rust = readRepoFile('../../desktop/src-tauri/src/document_window.rs')
  // `documentWindowPath` escapes; the Rust deliberately does not, and refuses
  // instead — the two must not drift into both assuming the other cleaned up.
  assert.match(rust, /pub fn is_document_id/)
  assert.match(rust, /is_ascii_alphanumeric\(\) \|\| character == '-' \|\| character == '_'/)
})
