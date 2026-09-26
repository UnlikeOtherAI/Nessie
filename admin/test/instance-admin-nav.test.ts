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
 * for them. System health reads worker heartbeats, queue counts and dead jobs,
 * none of which carry a tenant column.
 */

const viewer = (overrides: Partial<AdminNavViewer> = {}): AdminNavViewer => ({
  canManageOrganization: false,
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

const advanced = () => {
  const group = ADMIN_NAV.find((entry) => entry.id === 'advanced')
  assert.ok(group, 'no Advanced nav group')
  return group
}

test('System health and Mobile push setup are visible to the instance super-admin only', () => {
  for (const path of ['/admin/advanced/health', '/admin/advanced/push']) {
    assert.equal(isAdminNavItemVisible(navItem(path), viewer()), false, path)
    assert.equal(isAdminNavItemVisible(navItem(path), viewer({ isOwner: true })), false, path)
    assert.equal(isAdminNavItemVisible(navItem(path), viewer({ isSuperAdmin: true })), true, path)
  }
})

test('org-scoped operational surfaces retain their owner doorway', () => {
  // The neighbouring items read org-filtered data, so they are deliberately
  // NOT swept into the instance role along with System health.
  for (const path of ['/admin/usage', '/admin/security', '/admin/advanced/tools', '/admin/advanced/access-rules']) {
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

test('Advanced holds the rarely used controls, folded, for owners and instance operators', () => {
  assert.deepEqual(
    advanced().items.map((item) => [item.path, item.label]),
    [
      ['/admin/advanced/tools', 'Tool registry'],
      ['/admin/advanced/access-rules', 'Access rules'],
      ['/admin/advanced/health', 'System health'],
      ['/admin/advanced/push', 'Mobile push setup'],
      ['/admin/advanced/debug', 'Session debug'],
    ],
  )
  assert.equal(advanced().collapsedByDefault, true)
  assert.equal(isAdminNavGroupVisible(advanced(), viewer({ isOwner: true })), true)
  assert.equal(isAdminNavGroupVisible(advanced(), viewer({ isSuperAdmin: true })), true)
  assert.equal(isAdminNavGroupVisible(advanced(), viewer({ canManageOrganization: true, isAdmin: true })), false)
  assert.equal(isAdminNavGroupVisible(advanced(), viewer()), false)
  // Session debug is the one item both audiences share.
  const debug = navItem('/admin/advanced/debug')
  assert.equal(isAdminNavItemVisible(debug, viewer({ isOwner: true })), true)
  assert.equal(isAdminNavItemVisible(debug, viewer({ isSuperAdmin: true })), true)
  assert.equal(isAdminNavItemVisible(debug, viewer({ isAdmin: true })), false)
})

test('the organisation page is also reachable by an organisation admin', () => {
  assert.equal(
    isAdminNavItemVisible(
      navItem('/admin/organisation'),
      viewer({ canManageOrganization: true, isAdmin: true }),
    ),
    true,
  )
  assert.equal(isAdminNavItemVisible(navItem('/admin/organisation'), viewer({ isAdmin: true })), false)
})
