import assert from 'node:assert/strict'
import test from 'node:test'

import * as ReactNamespace from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AlertRow } from '../src/components/shared/AlertRow.js'
import type { UserAlertRecord } from '../src/facades/alerts/hooks.js'
import { teamInvitationLabel } from '../src/lib/team-invitation-label.js'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof ReactNamespace }).React = ReactNamespace

const invitation: UserAlertRecord = {
  actorAgentId: null,
  actorDisplayName: null,
  actorUserId: null,
  channelId: null,
  channelLabel: null,
  createdAt: '2026-09-13T12:00:00.000Z',
  id: '33333333-3333-3333-3333-333333333333',
  kind: 'team_invitation',
  knowledgePageId: null,
  messageId: null,
  metadata: {
    inviteId: 'invite-bravo-three',
    organizationId: 'uoa-org-bravo',
    orgName: 'Bravo Org',
    teamId: 'uoa-team-bravo-three',
    teamName: 'Bravo Three',
  },
  projectId: null,
  readAt: null,
  rootMessageId: null,
  taskId: null,
  threadId: null,
  triggerId: null,
}

test('a known organisation is part of the invitation name', () => {
  assert.equal(
    teamInvitationLabel({ orgName: 'Bravo Org', teamName: 'General' }),
    'General · Bravo Org',
  )
})

test('an unknown or blank organisation leaves the team name alone', () => {
  assert.equal(teamInvitationLabel({ teamName: 'General' }), 'General')
  assert.equal(teamInvitationLabel({ orgName: '   ', teamName: 'General' }), 'General')
})

test('the alert row names the inviting organisation, with and without an inviter', () => {
  const withInviter = renderToStaticMarkup(createElement(AlertRow, {
    alert: {
      ...invitation,
      metadata: { ...invitation.metadata!, invitedBy: 'Test B' },
    },
  }))
  assert.match(withInviter, /Test B invited you to Bravo Three · Bravo Org/)

  const withoutInviter = renderToStaticMarkup(createElement(AlertRow, { alert: invitation }))
  assert.match(withoutInviter, /Bravo Three · Bravo Org/)
  assert.doesNotMatch(withoutInviter, /invited you/)
})

test('an invitation with no organisation name still renders its team', () => {
  const html = renderToStaticMarkup(createElement(AlertRow, {
    alert: {
      ...invitation,
      metadata: { ...invitation.metadata!, orgName: undefined },
    },
  }))
  assert.match(html, />Bravo Three</)
  assert.doesNotMatch(html, /·/)
})
