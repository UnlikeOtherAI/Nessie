import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

test('Unread messages is shown directly below Threads only when direct messages are unread', () => {
  const sidebar = readSource('../src/layouts/admin-shell/SidebarNav.tsx')

  assert.match(sidebar, /unreadDirectMessageCount > 0/)
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
