import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildToolPolicy,
  isAgentToolAccessBuiltin,
  isDesignerCatalogBuiltin,
  type DesignerToolOption,
} from '../src/facades/designer/tool-catalog.js'

const tool = (overrides: Record<string, unknown> = {}) => ({
  builtin: true,
  enabled: true,
  id: 'ordinary_tool',
  personalAssistantOnly: false,
  projectDelegatedOnly: false,
  requiresExplicitGrant: false,
  ...overrides,
})

test('agent tool access shows explicit grants but only project-eligible PA tools', () => {
  assert.equal(isAgentToolAccessBuiltin(tool({
    id: 'ticket_create',
    personalAssistantOnly: true,
    projectDelegatedOnly: true,
  })), true)
  assert.equal(isAgentToolAccessBuiltin(tool({
    id: 'agent_peer_delegate',
    requiresExplicitGrant: true,
  })), true)
  assert.equal(isAgentToolAccessBuiltin(tool({
    id: 'browser_open',
    requiresExplicitGrant: true,
  })), true)
  assert.equal(isAgentToolAccessBuiltin(tool({
    id: 'authored_message_search',
    personalAssistantOnly: true,
  })), false)
})

test('agent tool access still hides disabled builtins', () => {
  assert.equal(isAgentToolAccessBuiltin(tool({
    enabled: false,
    id: 'ticket_create',
    personalAssistantOnly: true,
    projectDelegatedOnly: true,
  })), false)
})

const grant = (key: string): DesignerToolOption => ({
    allowMode: true,
    defaultEnabled: false,
    description: key,
    group: 'Projects',
    key,
    kind: 'builtin',
    label: key,
  })

test('explicit and project-delegated grants serialize as default-off allows', () => {
  const grants = [grant('browser_open'), grant('agent_peer_delegate'), grant('ticket_create')]

  assert.deepEqual(buildToolPolicy(grants, {}), {})
  assert.deepEqual(
    buildToolPolicy(grants, { agent_peer_delegate: true, browser_open: true, ticket_create: true }),
    { agent_peer_delegate: true, browser_open: true, ticket_create: true },
  )
})


test('create and non-owner catalogues omit protected tools before policy serialization', () => {
  const browser = tool({ id: 'browser_open', requiresExplicitGrant: true })
  assert.equal(isDesignerCatalogBuiltin(browser, false), false)
  assert.equal(isDesignerCatalogBuiltin(browser, true), false)
  assert.equal(isDesignerCatalogBuiltin(browser, true, 'registry-browser'), true)
})
