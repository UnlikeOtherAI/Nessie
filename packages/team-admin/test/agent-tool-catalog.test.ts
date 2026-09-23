import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'

import { loadAgentToolCatalog } from '../src/agent-tool-catalog.js'
import { buildGlobalAgentCatalogueBlock } from '../src/global-agent-catalogue.js'

const cataloguePrisma = {
  toolRegistryEntry: {
    findMany: async () => [],
  },
}

test('the Designer catalogue keeps project-delegated PA tools visible to the owner', async () => {
  const catalogue = await loadAgentToolCatalog(cataloguePrisma as never, {
    organizationId: 'org-1',
  })

  assert.ok(catalogue.togglable.some((entry) => entry.key === 'ticket_create'))
  assert.ok(catalogue.restricted.some((entry) => entry.key === 'ticket_board_create'))
  assert.ok(catalogue.restricted.some((entry) => entry.key === 'authored_message_search'))
})

// Run setup lends a project board tool only when the policy says `true`, so a
// catalogue that called them "on by default" had the Designer promise an agent
// the board and then build it without a single ticket tool.
test('every project board tool is off until the policy grants it, and says where it works', async () => {
  const catalogue = await loadAgentToolCatalog(cataloguePrisma as never, {
    organizationId: 'org-1',
  })
  const entries = new Map(
    [...catalogue.togglable, ...catalogue.restricted].map((entry) => [entry.key, entry]),
  )
  const projectTools = BUILTIN_TOOL_DEFINITIONS.filter((tool) => tool.projectDelegatedOnly)
  assert.ok(projectTools.length > 0)
  for (const tool of projectTools) {
    const entry = entries.get(tool.id)
    assert.ok(entry, `${tool.id} is in the catalogue`)
    assert.equal(entry.allowMode, true, `${tool.id} is allow-mode`)
    assert.equal(entry.defaultEnabled, false, `${tool.id} is off by default`)
    assert.equal(entry.projectChannelOnly, true, `${tool.id} is marked project-channel only`)
  }
  // Ordinary builtins keep their deny-mode default and carry no marker.
  const webSearch = entries.get('web_search')
  assert.equal(webSearch?.allowMode, false)
  assert.equal(webSearch?.defaultEnabled, true)
  assert.equal(webSearch?.projectChannelOnly, undefined)

  const rendered = buildGlobalAgentCatalogueBlock({
    catalogue,
    executors: [],
    models: null,
    writeSurface: 'agent_tools',
  })
  const ticketCreate = rendered.split('\n').find((line) => line.startsWith('- ticket_create ('))
  assert.ok(ticketCreate)
  assert.match(ticketCreate, /off by default; set true; works only in the project channels it is bound to/)
  assert.doesNotMatch(ticketCreate, /on by default/)
  assert.match(rendered, /project board tools are OFF unless the policy says true/)
})
