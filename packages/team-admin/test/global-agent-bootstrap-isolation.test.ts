import assert from 'node:assert/strict'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'

import {
  ensureGlobalAgentsForUser,
  GlobalAgentBootstrapFailures,
} from '../src/global-agent-bootstrap.js'
import { listGlobalAgentBlueprints } from '../src/global-agent-blueprints.js'

/**
 * One blueprint that cannot be provisioned must not withhold the others.
 *
 * The loop used to abort on the first failure, and its caller
 * (`attemptGlobalAgentsBootstrap`) swallows what it throws by design — a
 * blueprint problem must never lock somebody out of their team. Together those
 * two facts meant a single failing blueprint silently removed every blueprint
 * after it from the organisation, with nothing anywhere saying so. The tier is
 * listed from the rows — the Agents page's Global tab, the DM address book, the
 * identity directory that resolves a reply's author — so a row nobody ever
 * wrote reads as "this global agent does not exist here".
 */

const input = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  teamId: '00000000-0000-4000-8000-000000000003',
  userId: '00000000-0000-4000-8000-000000000002',
}

test('every blueprint is attempted, and the failures are reported together', async () => {
  let attempts = 0
  // `ensureGlobalAgentSystemTeam` is the first thing each bootstrap does, so a
  // transaction that always throws fails each blueprint at the same point.
  const prisma = {
    $transaction: async () => {
      attempts += 1
      throw new Error('provisioning is unavailable')
    },
  } as unknown as PrismaClient

  const slugs = listGlobalAgentBlueprints().map((blueprint) => blueprint.slug)
  assert.ok(slugs.length > 1, 'this asserts nothing with a single blueprint registered')

  await assert.rejects(ensureGlobalAgentsForUser(prisma, input), (error: unknown) => {
    assert.ok(error instanceof GlobalAgentBootstrapFailures)
    // Named in full: an operator reading the swallowed log line learns which
    // agents this person does not have, not just the first one to break.
    assert.deepEqual(error.failures.map((failure) => failure.blueprintSlug), slugs)
    for (const failure of error.failures) {
      assert.match((failure.cause as Error).message, /provisioning is unavailable/)
    }
    return true
  })

  assert.equal(attempts, slugs.length, 'the loop stopped at the first failure')
})
