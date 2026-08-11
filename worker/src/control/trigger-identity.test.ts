import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTriggerExecutionOrigin } from './trigger-origin.js'

/**
 * A fire has no session, so the creator's UOA identity has to travel with the
 * trigger. These pin the carrying: it must survive from `launchOrigin` onto the
 * execution origin, and its absence must stay absent rather than being invented
 * from anything mutable.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1'
const TEAM = '00000000-0000-4000-8000-0000000000b1'
const USER = '00000000-0000-4000-8000-0000000000c1'

const identity = {
  organizationId: 'uoa-org',
  subject: 'uoa-sub',
  teamId: 'uoa-team',
  tokenVersion: 17,
}

const agent = { organizationId: ORG, projectId: null, teamId: TEAM }

test('a captured UOA identity reaches the execution origin', () => {
  const origin = resolveTriggerExecutionOrigin({
    agent,
    channelOrganizationId: ORG,
    config: {
      createdByUserId: USER,
      launchOrigin: { organizationId: ORG, teamId: TEAM, uoaIdentity: identity, userId: USER },
    },
    triggerType: 'interval',
  })
  assert.deepEqual(origin.uoaIdentity, identity)
  assert.equal(origin.userId, USER)
})

test('a schedule created before capture carries none — and none is invented', () => {
  const origin = resolveTriggerExecutionOrigin({
    agent,
    channelOrganizationId: ORG,
    config: {
      createdByUserId: USER,
      launchOrigin: { organizationId: ORG, teamId: TEAM, userId: USER },
    },
    triggerType: 'interval',
  })
  assert.equal(origin.uoaIdentity, undefined)
})

test('a malformed identity fails the whole origin closed, never partially trusted', () => {
  // The identity is part of the launch origin, so a half-formed tuple
  // invalidates the origin rather than quietly degrading to "no identity" —
  // which would let a schedule run under weaker provenance than it was
  // created with.
  assert.throws(
    () =>
      resolveTriggerExecutionOrigin({
        agent,
        channelOrganizationId: ORG,
        config: {
          createdByUserId: USER,
          launchOrigin: {
            organizationId: ORG,
            teamId: TEAM,
            uoaIdentity: { subject: 'uoa-sub' },
            userId: USER,
          },
        },
        triggerType: 'interval',
      }),
    /missing or malformed/,
  )
})
