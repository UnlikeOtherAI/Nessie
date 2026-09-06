import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('Unread messages is a permanent bold destination directly below Threads', () => {
  const sidebar = readSource('../src/layouts/admin-shell/SidebarNav.tsx')

  assert.doesNotMatch(sidebar, /unreadDirectMessageCount > 0/)
  assert.match(sidebar, /admin-sb-item sidebar-threads sidebar-unread-messages group/)
  assert.match(sidebar, /<span>Unread messages<\/span>/)
  assert.ok(sidebar.indexOf('sidebar-threads') < sidebar.indexOf('sidebar-unread-messages'))
  assert.ok(sidebar.indexOf('sidebar-unread-messages') < sidebar.indexOf('<SidebarStarredSection'))
})

test('unread message rows open their direct-message conversation', () => {
  const page = readSource('../src/pages/UnreadMessagesPage.tsx')
  const router = readSource('../src/router.tsx')

  assert.match(page, /onClick=\{\(\) => void navigate\(/)
  // Route-level code splitting (05-pages-routing.md F1): UnreadMessagesPage
  // is lazy-loaded, not statically imported, so the route wires the lazy
  // component through the shared `lazyElement` Suspense wrapper.
  assert.match(router, /path: '\/unread-messages', element: lazyElement\(UnreadMessagesPage, 'list'\)/)
})

test('the empty unread inbox is the shared caught-up card', () => {
  const page = readSource('../src/pages/UnreadMessagesPage.tsx')

  // Content design system migration (2026-09-01): the bespoke dashed card is
  // now the shared `EmptyState` primitive (which itself renders the dashed
  // border every other empty list in the admin uses), inside `PageBody`
  // rather than a page-local centering wrapper.
  assert.match(page, /<EmptyState title="You are all caught up">/)
  assert.match(page, /import \{ EmptyState \} from '..\/components\/shared\/EmptyState'/)
  assert.doesNotMatch(page, /No unread messages/)
})
