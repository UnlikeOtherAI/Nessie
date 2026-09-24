import assert from 'node:assert/strict'
import test from 'node:test'

import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AlertRow } from '../src/components/shared/AlertRow.js'
import { getAlertLink, type UserAlertRecord } from '../src/facades/alerts/hooks.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

// A ticket trigger an agent set up for the reader: machine access is still the
// machines' owner's to set up (docs/plans/2026-09-23-ticket-driven-agents/
// setup-and-ui.md → "The project-operator capability").
const machineAccess: UserAlertRecord = {
  actorAgentId: '11111111-1111-4111-8111-111111111111',
  actorDisplayName: 'CTO',
  actorUserId: null,
  channelId: null,
  channelLabel: null,
  createdAt: '2026-09-24T12:00:00.000Z',
  id: '33333333-3333-4333-8333-333333333333',
  kind: 'trigger_machine_access',
  knowledgePageId: null,
  messageId: null,
  metadata: null,
  projectId: '44444444-4444-4444-8444-444444444444',
  readAt: null,
  rootMessageId: null,
  taskId: null,
  threadId: null,
  triggerId: '55555555-5555-4555-8555-555555555555',
  triggerName: 'CTO pickup',
}

test('a machine-access item names the trigger it is for', () => {
  const html = renderToStaticMarkup(createElement(AlertRow, { alert: machineAccess }))
  // True before the trigger page has a Machine access section: it says who
  // sets it up and where, and promises no button on the page it opens.
  assert.match(html, />CTO pickup needs machine access: ask the machines’ owner to set it up, /)
  assert.match(html, /set it up, from the trigger’s page or the Agent Designer</)

  const unnamed = renderToStaticMarkup(createElement(AlertRow, { alert: { ...machineAccess, triggerName: null } }))
  assert.match(unnamed, />A ticket trigger needs machine access: /)
})

test('a machine-access item opens the trigger it is for', () => {
  assert.deepEqual(getAlertLink(machineAccess), { to: `/agents/triggers/${machineAccess.triggerId}` })
})
