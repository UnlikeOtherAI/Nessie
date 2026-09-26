import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ADMIN_NAV,
  isAdminNavGroupVisible,
  isAdminNavItemActive,
  isAdminNavItemVisible,
  type AdminNavViewer,
} from '../src/layouts/admin-shell/AdminSidebarNav.js'

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

const peopleItem = () => navItem('/admin/people')
const organisationGroup = () => {
  const group = ADMIN_NAV.find((entry) => entry.id === 'organisation')
  assert.ok(group, 'no Organisation nav group')
  return group
}

test('a UOA session shows People to every active member, who reads their own teams', () => {
  assert.equal(isAdminNavItemVisible(peopleItem(), viewer({ isUoaSession: true })), true)
  assert.equal(
    isAdminNavItemVisible(peopleItem(), viewer({ canManageOrganization: true, isUoaSession: true })),
    true,
  )
})

test('a local session keeps People to the owner or an organisation administrator', () => {
  assert.equal(isAdminNavItemVisible(peopleItem(), viewer()), false)
  assert.equal(isAdminNavItemVisible(peopleItem(), viewer({ isOwner: true })), true)
  assert.equal(isAdminNavItemVisible(peopleItem(), viewer({ canManageOrganization: true })), true)
})

test('the Organisation group renders whenever one of its items does', () => {
  // A plain member on an SSO session sees "Organisation · People" and nothing
  // else from the group.
  const member = viewer({ isUoaSession: true })
  assert.equal(isAdminNavGroupVisible(organisationGroup(), member), true)
  assert.deepEqual(
    organisationGroup().items
      .filter((item) => isAdminNavItemVisible(item, member))
      .map((item) => item.label),
    ['People'],
  )
  // A plain member of a local install sees no group at all.
  assert.equal(isAdminNavGroupVisible(organisationGroup(), viewer()), false)
})

test('the UOA session flag widens only People', () => {
  const widened = ADMIN_NAV.flatMap((group) => group.items).filter(
    (item) =>
      !isAdminNavItemVisible(item, viewer())
      && isAdminNavItemVisible(item, viewer({ isUoaSession: true })),
  )

  assert.deepEqual(
    widened.map((item) => item.path).sort(),
    ['/admin/people'],
  )
})

test('owner-only items stay owner-only on a UOA session', () => {
  for (const path of ['/admin/advanced/tools', '/admin/keys', '/admin/usage']) {
    assert.equal(
      isAdminNavItemVisible(navItem(path), viewer({ isUoaSession: true })),
      false,
      `${path} must stay owner-only`,
    )
  }
})

test('the organisation items carry the gates the audience of each page needs', () => {
  const admin = viewer({ isAdmin: true })
  assert.deepEqual(
    organisationGroup().items
      .filter((item) => isAdminNavItemVisible(item, admin))
      .map((item) => item.label),
    ['Teams', 'AI models', 'Company connections', 'Credits and billing', 'Security'],
  )
  const owner = viewer({ canManageOrganization: true, isOwner: true })
  assert.deepEqual(
    organisationGroup().items
      .filter((item) => isAdminNavItemVisible(item, owner))
      .map((item) => item.label),
    [
      'People', 'Teams', 'Organisation', 'AI models', 'Company connections', 'Keys',
      'Usage and limits', 'Credits and billing', 'Security',
    ],
  )
})

test('a team page keeps Teams active, and People owns its own route', () => {
  assert.equal(isAdminNavItemActive(navItem('/admin/teams'), '/admin/teams/team-1'), true)
  assert.equal(isAdminNavItemActive(navItem('/admin/people'), '/admin/people'), true)
  assert.equal(isAdminNavItemActive(navItem('/admin/teams'), '/admin/people'), false)
})
