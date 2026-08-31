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
  assert.match(router, /path: '\/unread-messages', element: <UnreadMessagesPage \/>/)
})

test('the empty unread inbox is a single centered caught-up card', () => {
  const page = readSource('../src/pages/UnreadMessagesPage.tsx')

  assert.match(page, /flex min-h-full items-center justify-center p-4/)
  assert.match(page, /border border-dashed/)
  assert.match(page, /You are all caught up/)
  assert.doesNotMatch(page, /No unread messages/)
})
