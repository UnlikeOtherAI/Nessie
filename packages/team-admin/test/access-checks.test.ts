import assert from 'node:assert/strict'
import test from 'node:test'

import { isAgentAccessibleToActor } from '../src/access-checks.js'
import { resolveAgentEditAuthority } from '../src/agent-edit-authority.js'

test('an access check refuses a live entitlement issued to another actor', async () => {
  let queries = 0
  const result = await isAgentAccessibleToActor({
    agent: { count: async () => { queries += 1; return 1 } },
  } as never, {
    actionContext: { requestId: 'request-1' },
    actor: { actorId: 'user-a', actorType: 'user' },
    tenant: { organizationId: 'organization-a' },
  } as never, 'agent-1', {
    kind: 'uoa',
    organizationId: 'organization-b',
    organizationRole: 'owner',
    teamIds: [],
    userId: 'user-b',
  })

  assert.equal(result, false)
  assert.equal(queries, 0)
})

test('agent editing rejects a supplied live entitlement from another organization', async () => {
  const result = await resolveAgentEditAuthority({} as never, {
    organizationId: 'organization-a', userId: 'user-a',
  }, {
    id: 'agent-1', organizationId: 'organization-a', ownerUserId: 'user-a',
    systemManaged: false, visibility: 'team',
  }, {
    kind: 'uoa', organizationId: 'organization-b', organizationRole: 'owner',
    teamIds: [], userId: 'user-b',
  })

  assert.equal(result.canEdit, false)
  assert.equal(result.refusal?.code, 'AGENT_EDIT_MEMBERSHIP_INACTIVE')
})
