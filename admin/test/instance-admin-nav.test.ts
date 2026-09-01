import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ADMIN_NAV,
  isAdminNavGroupVisible,
  isAdminNavItemVisible,
  type AdminNavViewer,
} from '../src/layouts/admin-shell/AdminSidebarNav.js'

/**
 * Instance administration is `User.superAdmin`, not "owner of the shared
 * organization". Under the old flattened single-organisation model those were
 * indistinguishable; with one `Organization` per UOA organisation an org owner
 * administers exactly one tenant, so a deployment-wide surface must not open
 * for them. `/ops` (System Health) reads worker heartbeats, queue counts and
 * dead jobs, none of which carry a tenant column.
 */

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

const platform = () => {
  const group = ADMIN_NAV.find((entry) => entry.id === 'platform')
  assert.ok(group, 'no Platform nav group')
  return group
}

test('System Health is visible to the instance super-admin only', () => {
  const health = navItem('/ops')

  assert.equal(isAdminNavItemVisible(health, viewer()), false)
  assert.equal(isAdminNavItemVisible(health, viewer({ isOwner: true })), false)
  assert.equal(isAdminNavItemVisible(health, viewer({ isSuperAdmin: true })), true)
})

test('org-scoped operational surfaces retain their owner doorway', () => {
  // The neighbouring items read org-filtered data, so they are deliberately
  // NOT swept into the instance role along with Health.
  for (const path of ['/ops/usage', '/audit', '/settings/organization']) {
    assert.equal(
      isAdminNavItemVisible(navItem(path), viewer({ isOwner: true })),
      true,
      `${path} must stay reachable by an org owner`,
    )
    assert.equal(
      isAdminNavItemVisible(navItem(path), viewer({ isSuperAdmin: true })),
      false,
      `${path} is organisation-scoped, so superAdmin alone must not open it`,
    )
  }
})

test('Platform owns both operational and instance controls without creating an empty section', () => {
  assert.deepEqual(
    platform().items.map((item) => item.path),
    ['/ops', '/settings/push', '/audit', '/policy', '/ops/usage'],
  )
  assert.equal(ADMIN_NAV.some((group) => group.id === 'ops'), false)
  assert.equal(isAdminNavGroupVisible(platform(), viewer({ isOwner: true })), true)
  assert.equal(isAdminNavGroupVisible(platform(), viewer({ isSuperAdmin: true })), true)
  assert.equal(isAdminNavGroupVisible(platform(), viewer()), false)
})

test('organization settings are also reachable by an organization admin', () => {
  assert.equal(
    isAdminNavItemVisible(navItem('/settings/organization'), viewer({ isAdmin: true })),
    true,
  )
})
