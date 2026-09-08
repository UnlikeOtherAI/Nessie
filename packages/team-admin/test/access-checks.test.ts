import assert from 'node:assert/strict'
import test from 'node:test'

import { isAgentAccessibleToActor } from '../src/access-checks.js'

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
