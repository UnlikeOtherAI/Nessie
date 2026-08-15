import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ADMIN_NAV,
  isAdminNavItemVisible,
  type AdminNavViewer,
} from '../src/layouts/admin-shell/AdminSidebarNav.js'

const viewer = (overrides: Partial<AdminNavViewer> = {}): AdminNavViewer => ({
  isOwner: false,
  isSuperAdmin: false,
  isUoaSession: false,
  ...overrides,
})

const navItem = (path: string) => {
  const item = ADMIN_NAV.flatMap((group) => group.items).find((entry) => entry.path === path)
  assert.ok(item, `no admin nav item for ${path}`)
  return item
}

const membersItem = () => navItem('/settings/members')

test('a UOA session shows Members to every active member', () => {
  assert.equal(isAdminNavItemVisible(membersItem(), viewer({ isUoaSession: true })), true)
  assert.equal(
    isAdminNavItemVisible(membersItem(), viewer({ isUoaSession: true, isOwner: true })),
    true,
  )
})

test('a local session keeps Members owner-only', () => {
  assert.equal(isAdminNavItemVisible(membersItem(), viewer()), false)
  assert.equal(isAdminNavItemVisible(membersItem(), viewer({ isOwner: true })), true)
})

test('the UOA session flag widens nothing else', () => {
  const widened = ADMIN_NAV.flatMap((group) => group.items).filter(
    (item) =>
      !isAdminNavItemVisible(item, viewer())
      && isAdminNavItemVisible(item, viewer({ isUoaSession: true })),
  )

  assert.deepEqual(
    widened.map((item) => item.path),
    ['/settings/members'],
  )
})

test('owner-only items stay owner-only on a UOA session', () => {
  for (const path of ['/agents/tools', '/settings/organization', '/audit', '/ops/usage']) {
    assert.equal(
      isAdminNavItemVisible(navItem(path), viewer({ isUoaSession: true })),
      false,
      `${path} must stay owner-only`,
    )
  }
})
