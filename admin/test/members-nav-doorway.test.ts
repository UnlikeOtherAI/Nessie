import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ADMIN_NAV,
  isAdminNavItemActive,
  isAdminNavItemVisible,
  type AdminNavViewer,
} from '../src/layouts/admin-shell/AdminSidebarNav.js'

const viewer = (overrides: Partial<AdminNavViewer> = {}): AdminNavViewer => ({
  isAdmin: false,
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
const teamMembersItem = () => navItem('/settings/team/members')

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

test('a UOA session shows Team > Members to every active member, same as Organization > Members', () => {
  assert.equal(isAdminNavItemVisible(teamMembersItem(), viewer({ isUoaSession: true })), true)
  assert.equal(
    isAdminNavItemVisible(teamMembersItem(), viewer({ isUoaSession: true, isOwner: true })),
    true,
  )
})

test('a local session keeps Team > Members owner-only, same as Organization > Members', () => {
  assert.equal(isAdminNavItemVisible(teamMembersItem(), viewer()), false)
  assert.equal(isAdminNavItemVisible(teamMembersItem(), viewer({ isOwner: true })), true)
})

test('the UOA session flag widens nothing else', () => {
  const widened = ADMIN_NAV.flatMap((group) => group.items).filter(
    (item) =>
      !isAdminNavItemVisible(item, viewer())
      && isAdminNavItemVisible(item, viewer({ isUoaSession: true })),
  )

  assert.deepEqual(
    widened.map((item) => item.path).sort(),
    ['/settings/members', '/settings/team/members'],
  )
})

test('owner-only items stay owner-only on a UOA session', () => {
  for (const path of ['/agents/tools', '/audit', '/ops/usage']) {
    assert.equal(
      isAdminNavItemVisible(navItem(path), viewer({ isUoaSession: true })),
      false,
      `${path} must stay owner-only`,
    )
  }
})

test('Team Members owns its route without also selecting Team Settings', () => {
  assert.equal(isAdminNavItemActive(navItem('/settings/team/members'), '/settings/team/members'), true)
  assert.equal(isAdminNavItemActive(navItem('/settings/team'), '/settings/team/members'), false)
})
