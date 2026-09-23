import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { parseOrganizationId, parseTeamId, type AuthorizedActionContext } from '@nessie/schemas'
import {
  UNRELEASED_TRIGGER_TYPES,
  unreleasedTriggerTypeRefusal,
  workflowTriggerTypeRefusal,
} from '@nessie/team-admin'

import { registerTriggerRoutes } from '../src/routes/triggers.js'
import { registerWorkflowInstallationRoutes } from '../src/routes/workflows/installations.js'

// `document_changed` parses as a trigger type but is not released for agents,
// and a workflow can never use it or `ticket_changed` (released for agents in
// T1): each create route answers with its own refusal sentence, before any
// identity capture, lookup or write, so an integration hears what to use
// instead rather than the generic "configuration is invalid".

const AGENT_ID = '30000000-0000-4000-8000-000000000001'
const INSTALLATION_ID = '30000000-0000-4000-8000-000000000002'
const CHANNEL_ID = '30000000-0000-4000-8000-000000000003'

const actorContext: AuthorizedActionContext = {
  actor: { actorId: '30000000-0000-4000-8000-000000000004', actorType: 'user', roles: ['owner'] },
  actionContext: { requestId: 'unreleased-trigger-type' },
  tenant: {
    organizationId: parseOrganizationId('30000000-0000-4000-8000-000000000005'),
    teamId: parseTeamId('30000000-0000-4000-8000-000000000006'),
  },
}

const untouchable = new Proxy({}, {
  get: (_target, property) => {
    throw new Error(`an unreleased type must be refused before prisma.${String(property)} is touched`)
  },
}) as PrismaClient

const buildApp = () => {
  const app = Fastify({ logger: false })
  const deps = {
    isAgentAccessibleToActor: async () => true,
    isWorkflowInstallationAccessibleToActor: async () => true,
    prisma: untouchable,
    requireActorContext: () => actorContext,
    requireOwner: () => true,
    requireUserActor: () => true,
  }
  registerTriggerRoutes(app, deps as unknown as Parameters<typeof registerTriggerRoutes>[1])
  registerWorkflowInstallationRoutes(app, deps as unknown as Parameters<typeof registerWorkflowInstallationRoutes>[1])
  return app
}

test('both trigger create routes refuse each type they cannot create with their sentence', async () => {
  const app = buildApp()
  assert.deepEqual([...UNRELEASED_TRIGGER_TYPES], ['document_changed'])
  try {
    const cases = [
      ...UNRELEASED_TRIGGER_TYPES.map((type) => ({
        payload: { targetChannelId: CHANNEL_ID, type },
        refusal: unreleasedTriggerTypeRefusal(type),
        url: `/api/agents/${AGENT_ID}/triggers`,
      })),
      ...(['ticket_changed', 'document_changed'] as const).map((type) => ({
        payload: { type },
        refusal: workflowTriggerTypeRefusal(type),
        url: `/api/workflow-installations/${INSTALLATION_ID}/triggers`,
      })),
    ]
    for (const { payload, refusal, url } of cases) {
      assert.ok(refusal, `${url} has a refusal for ${payload.type}`)
      const response = await app.inject({ method: 'POST', payload, url })
      assert.equal(response.statusCode, 400, `${url} ${payload.type}`)
      const body = response.json() as { error: { code: string; message: string } }
      assert.equal(body.error.code, 'TRIGGER_TYPE_UNAVAILABLE')
      assert.equal(body.error.message, refusal)
    }
  } finally {
    await app.close()
  }
})
