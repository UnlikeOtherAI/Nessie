import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ADMIN_NAV,
  isAdminNavItemActive,
} from '../src/layouts/admin-shell/AdminSidebarNav.js'

const agentsGroup = ADMIN_NAV.find((group) => group.id === 'agents')
const agentsItem = agentsGroup?.items.find((item) => item.path === '/admin/agents')

test('the Agents group is Agents, Apps, Computers and Automations, with no Designer item', () => {
  assert.ok(agentsGroup, 'agents group exists')
  assert.deepEqual(
    agentsGroup.items.map((item) => [item.path, item.label]),
    [
      ['/admin/agents', 'Agents'],
      ['/admin/apps', 'Apps'],
      ['/admin/computers', 'Computers'],
      ['/admin/automations', 'Automations'],
    ],
  )
  assert.equal(
    agentsGroup.items.some((item) => item.path.includes('designer')),
    false,
    'no standalone Designer nav item',
  )
})

test('an agent, New agent and a mailbox keep "Agents" highlighted', () => {
  assert.ok(agentsItem, 'Agents item exists')
  for (const path of [
    '/admin/agents',
    '/admin/agents/new',
    '/admin/agents/agent-abc-123',
    '/admin/agents/agent-abc-123/mailbox',
  ]) {
    assert.equal(isAdminNavItemActive(agentsItem, path), true, `Agents active on ${path}`)
  }
})

test('sibling pages own their own routes (no double-highlight)', () => {
  // New agent lights up ONLY the Agents item.
  const others = agentsGroup!.items.filter((item) => item.path !== '/admin/agents')
  for (const item of others) {
    assert.equal(
      isAdminNavItemActive(item, '/admin/agents/new'),
      false,
      `${item.path} must not activate on New agent`,
    )
  }
  // And Agents does not steal a sibling's own route, nor a prefix look-alike.
  assert.equal(isAdminNavItemActive(agentsItem!, '/admin/automations'), false)
  assert.equal(isAdminNavItemActive(agentsItem!, '/admin/automations/triggers/t-1'), false)
  assert.equal(isAdminNavItemActive(agentsItem!, '/admin/computers/c-1'), false)
  assert.equal(isAdminNavItemActive(agentsItem!, '/admin/agentsX'), false)
})
