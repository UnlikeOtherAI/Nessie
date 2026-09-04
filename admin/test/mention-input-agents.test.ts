import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

import { readAgentMentions } from '../src/components/shared/mention-input-agents.js'

test('reads and deduplicates every picker-inserted agent identity', () => {
  const agentId = '00000000-0000-4000-8000-000000000001'
  const principalUserId = '00000000-0000-4000-8000-000000000002'
  const dom = new JSDOM(`
    <div id="editor">
      <span data-mention-type="agent" data-mention-id="${agentId}">@Same name</span>
      <span data-mention-type="agent" data-mention-id="${agentId}">@Same name</span>
      <span
        data-mention-type="agent"
        data-mention-id="${agentId}"
        data-mention-principal-user-id="${principalUserId}"
      >@Owner – PA</span>
    </div>
  `)

  assert.deepEqual(
    readAgentMentions(dom.window.document.querySelector<HTMLElement>('#editor')),
    [
      { agentId, type: 'agent' },
      { agentId, principalUserId, type: 'agent' },
    ],
  )
})
