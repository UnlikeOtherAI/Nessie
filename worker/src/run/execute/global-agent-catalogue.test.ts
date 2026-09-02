import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentEffortSchema, AgentVisibilitySchema } from '@nessie/schemas'
import type { AgentToolCatalog } from '@nessie/workspace-admin'

import { buildGlobalAgentCatalogueBlock } from './global-agent-catalogue.js'

/**
 * The design catalogue renders from live definitions, never from prose somebody
 * has to remember to update. These cases pin exactly that: a tool that exists
 * appears with its policy key, a tool nobody may grant is named with the reason,
 * and the parameter facts come from the contracts that validate them.
 */

const catalogue = (
  overrides: Partial<AgentToolCatalog> = {},
): AgentToolCatalog => ({
  connectorCount: 1,
  restricted: [
    {
      allowMode: false,
      defaultEnabled: true,
      group: 'Agents & delegation',
      key: 'agent_create',
      kind: 'builtin',
      label: 'Create Agent',
      restriction: 'personal_assistant_only',
      summary: 'Create a shared agent.',
    },
  ],
  togglable: [
    {
      allowMode: false,
      defaultEnabled: true,
      group: 'Web & research',
      key: 'web_search',
      kind: 'builtin',
      label: 'Web Search',
      summary: 'Search the public web.',
    },
    {
      allowMode: true,
      defaultEnabled: false,
      group: 'Connectors (MCP)',
      key: '5e1b3c8a-0000-4000-8000-00000000abcd',
      kind: 'connector',
      label: 'Ticket create',
      summary: 'Create a ticket in the tracker.',
    },
  ],
  ...overrides,
})

const block = (overrides: Parameters<typeof buildGlobalAgentCatalogueBlock>[0] extends never
  ? never
  : Partial<Parameters<typeof buildGlobalAgentCatalogueBlock>[0]> = {}) =>
  buildGlobalAgentCatalogueBlock({
    catalogue: catalogue(),
    hasIdentityTools: true,
    models: null,
    ...overrides,
  })

test('a tool in the catalogue appears with its policy key and default', () => {
  const rendered = block()
  assert.match(rendered, /web_search \(Web Search\)/)
  assert.match(rendered, /on by default; set false to remove/)
  // A connector is keyed by its registry uuid and is off until allowed.
  assert.match(rendered, /5e1b3c8a-0000-4000-8000-00000000abcd \(Ticket create\)/)
  assert.match(rendered, /off by default; set true/)
})

test('a tool added to the registry appears without touching the prompt', () => {
  const withNewTool = block({
    catalogue: catalogue({
      togglable: [
        ...catalogue().togglable,
        {
          allowMode: true,
          defaultEnabled: false,
          group: 'Connectors (MCP)',
          key: 'aaaaaaaa-0000-4000-8000-00000000ffff',
          kind: 'connector',
          label: 'Deploy service',
          summary: 'Trigger a deployment.',
        },
      ],
    }),
  })
  assert.match(withNewTool, /Deploy service/)
  assert.match(withNewTool, /aaaaaaaa-0000-4000-8000-00000000ffff/)
})

test('tools nobody may grant are named with the reason, never offered', () => {
  const rendered = block()
  assert.match(rendered, /agent_create — Personal Assistant only/)
  assert.match(rendered, /not yours to grant/)
})

test('parameter facts render from the contracts that validate them', () => {
  const rendered = block()
  for (const option of AgentVisibilitySchema.options) {
    assert.ok(rendered.includes(option), `visibility ${option} is stated`)
  }
  for (const option of AgentEffortSchema.options) {
    assert.ok(rendered.includes(option), `effort ${option} is stated`)
  }
  assert.match(rendered, /maxTokens, maxToolCalls, maxIterations, maxWallclockMs, maxCostCents/)
})

test('the never-do facts are stated as facts', () => {
  const rendered = block()
  assert.match(rendered, /visibility cannot change after an agent is created/)
  assert.match(rendered, /Nobody edits them/)
  assert.match(rendered, /A private agent belongs to one person/)
  assert.match(rendered, /set by the server/)
})

test('an unreadable model catalogue says so rather than guessing', () => {
  assert.match(block({ models: null }), /could not be read just now/)
  const withModels = block({
    models: [
      {
        displayName: 'Kimi K2',
        model: 'kimi-k2',
        provider: 'kimi',
        providerDisplayName: 'Kimi',
        source: 'ledger',
      },
    ],
  })
  assert.match(withModels, /kimi\/kimi-k2 — Kimi K2/)
})

test('the block states plainly whether this run can write agents', () => {
  assert.match(block({ hasIdentityTools: true }), /You can create and change agents/)
  assert.match(
    block({ hasIdentityTools: false }),
    /cannot create or change agents in this conversation/,
  )
})
