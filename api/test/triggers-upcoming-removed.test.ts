import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { parseOrganizationId, parseTeamId, type AuthorizedActionContext } from '@nessie/schemas'

import { registerTriggerRoutes } from '../src/routes/triggers.js'

// `GET /api/triggers/upcoming` answered with the triggers due before now —
// overdue ones, not upcoming ones — and nothing read it. The 2026-08-11
// decision record (docs/plans/2026-08-11-unsurfaced-capabilities-decision.md)
// said to delete it rather than build a screen to justify it, and the admin
// overhaul (plan §9, §10.11) did. `GET /api/triggers/scheduled` stays.

const actorContext: AuthorizedActionContext = {
  actor: { actorId: '31000000-0000-4000-8000-000000000004', actorType: 'user', roles: ['owner'] },
  actionContext: { requestId: 'triggers-upcoming-removed' },
  tenant: {
    organizationId: parseOrganizationId('31000000-0000-4000-8000-000000000005'),
    teamId: parseTeamId('31000000-0000-4000-8000-000000000006'),
  },
}

const buildApp = (prisma: PrismaClient) => {
  const app = Fastify({ logger: false })
  registerTriggerRoutes(app, {
    isAgentAccessibleToActor: async () => true,
    prisma,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
    requireUserActor: () => true,
  } as unknown as Parameters<typeof registerTriggerRoutes>[1])
  return app
}

test('the overdue-trigger read is gone, and the scheduled list still answers', async () => {
  const app = buildApp({
    agentTrigger: { findMany: async () => [] },
  } as unknown as PrismaClient)
  try {
    // The address now falls through to one trigger's read, which refuses a
    // non-UUID id before any lookup: not found, the way any unknown id is.
    const upcoming = await app.inject({ method: 'GET', url: '/api/triggers/upcoming' })
    assert.equal(upcoming.statusCode, 404)
    assert.equal(JSON.parse(upcoming.body).error.code, 'TRIGGER_NOT_FOUND')

    const scheduled = await app.inject({ method: 'GET', url: '/api/triggers/scheduled' })
    assert.equal(scheduled.statusCode, 200)
    assert.deepEqual(JSON.parse(scheduled.body).data, [])
  } finally {
    await app.close()
  }
})
