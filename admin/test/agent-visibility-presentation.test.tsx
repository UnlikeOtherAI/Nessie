import assert from 'node:assert/strict'
import test from 'node:test'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'

import {
  AgentVisibilityPill,
  agentSelectionLabel,
} from '../src/components/shared/AgentVisibilityPill.js'
import { AgentVisibilityPicker } from '../src/components/features/agents/AgentVisibilityPicker.js'
import { agentOwnershipLabel } from '../src/components/features/agents/AgentOwnershipState.js'
import type { AgentRecord } from '../src/lib/api-client'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const documentFor = (element: React.ReactElement): Document =>
  new JSDOM(`<body>${renderToStaticMarkup(element)}</body>`).window.document

test('shared visibility is shown independently from ownership terminology', () => {
  const document = documentFor(createElement(AgentVisibilityPill, { visibility: 'team' }))

  assert.equal(document.body.textContent, 'Shared')
  assert.equal(agentSelectionLabel('Morning Joke', 'team'), 'Morning Joke — Shared')
  assert.equal(agentSelectionLabel('Morning Joke', 'private'), 'Morning Joke — Private')
})

test('an owner label does not rename a shared agent as team-owned', () => {
  const agent = {
    id: 'agent-1',
    name: 'Morning Joke',
    ownerUserId: 'viewer-1',
    visibility: 'team',
  } as AgentRecord

  assert.equal(
    agentOwnershipLabel(agent, { isOrgOwner: false, userId: 'viewer-1' }),
    'Owned by you',
  )
  assert.equal(
    agentOwnershipLabel({ ...agent, ownerUserId: null }, { isOrgOwner: false, userId: 'viewer-1' }),
    'Team-owned',
  )
})

test('the shared visibility choice explains channel-scoped addressability', () => {
  const document = documentFor(
    createElement(AgentVisibilityPicker, {
      onChange: () => undefined,
      value: 'team',
    }),
  )

  assert.equal(document.querySelector('[role="radio"]')?.textContent, 'Private')
  assert.match(document.body.textContent ?? '', /Shared/)
  assert.match(
    document.body.textContent ?? '',
    /People who can see its channels can find it; people who can post there can address it\./,
  )
  assert.doesNotMatch(document.body.textContent ?? '', /Public/)
})
