import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ADMIN_NAV,
  isAdminNavItemActive,
} from '../src/layouts/admin-shell/AdminSidebarNav.js'

const agentsGroup = ADMIN_NAV.find((group) => group.id === 'agents')
const agentsItem = agentsGroup?.items.find((item) => item.path === '/agents')

test('the Designer item is gone from the agents menu', () => {
  assert.ok(agentsGroup, 'agents group exists')
  assert.equal(
    agentsGroup.items.some((item) => item.path === '/agents/designer'),
    false,
    'no standalone Designer nav item',
  )
})

test('editing an agent keeps "Agents" highlighted, not a Designer item', () => {
  assert.ok(agentsItem, 'Agents item exists')
  for (const path of ['/agents', '/agents/designer', '/agents/designer/abc-123']) {
    assert.equal(isAdminNavItemActive(agentsItem, path), true, `Agents active on ${path}`)
  }
})

test('sibling agent pages still own their own routes (no double-highlight)', () => {
  // The designer routes light up ONLY the Agents item.
  const others = agentsGroup!.items.filter((item) => item.path !== '/agents')
  for (const item of others) {
    assert.equal(
      isAdminNavItemActive(item, '/agents/designer/abc-123'),
      false,
      `${item.path} must not activate on the agent designer`,
    )
  }
  // And Agents does not steal a sibling's own route.
  assert.equal(isAdminNavItemActive(agentsItem!, '/agents/activity'), false)
  assert.equal(isAdminNavItemActive(agentsItem!, '/agents/triggers'), false)
})
