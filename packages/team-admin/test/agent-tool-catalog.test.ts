import assert from 'node:assert/strict'
import test from 'node:test'

import { loadAgentToolCatalog } from '../src/agent-tool-catalog.js'

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
