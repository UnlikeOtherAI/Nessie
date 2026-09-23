import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { parseOrganizationId, parseTeamId, type AuthorizedActionContext } from '@nessie/schemas'
import { UNRELEASED_TRIGGER_TYPES, unreleasedTriggerTypeRefusal } from '@nessie/team-admin'

import { registerTriggerRoutes } from '../src/routes/triggers.js'
import { registerWorkflowInstallationRoutes } from '../src/routes/workflows/installations.js'

// `ticket_changed` and `document_changed` parse as trigger types but are not
// released: both create routes answer with the one refusal sentence, before
// any identity capture, lookup or write, so an integration hears what to use
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

test('both trigger create routes refuse each unreleased type with its sentence', async () => {
  const app = buildApp()
  try {
    for (const type of UNRELEASED_TRIGGER_TYPES) {
      for (const [url, payload] of [
        [`/api/agents/${AGENT_ID}/triggers`, { targetChannelId: CHANNEL_ID, type }],
        [`/api/workflow-installations/${INSTALLATION_ID}/triggers`, { type }],
      ] as const) {
        const response = await app.inject({ method: 'POST', payload, url })
        assert.equal(response.statusCode, 400, `${url} ${type}`)
        const body = response.json() as { error: { code: string; message: string } }
        assert.equal(body.error.code, 'TRIGGER_TYPE_UNAVAILABLE')
        assert.equal(body.error.message, unreleasedTriggerTypeRefusal(type))
      }
    }
  } finally {
    await app.close()
  }
})
