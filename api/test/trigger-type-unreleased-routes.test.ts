import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import { parseOrganizationId, parseTeamId, type AuthorizedActionContext } from '@nessie/schemas'
import { UNRELEASED_TRIGGER_TYPES, workflowTriggerTypeRefusal } from '@nessie/team-admin'

import { registerTriggerRoutes } from '../src/routes/triggers.js'
import { registerWorkflowInstallationRoutes } from '../src/routes/workflows/installations.js'

// Every agent trigger type is released (`ticket_changed` in T1,
// `document_changed` in T2), and a workflow can never use either of them: the
// workflow-trigger create route answers with its own refusal sentence, before
// any lookup or write, so an integration hears what to use instead rather than
// the generic "configuration is invalid".

const INSTALLATION_ID = '30000000-0000-4000-8000-000000000002'

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
    throw new Error(`an agent-only type must be refused before prisma.${String(property)} is touched`)
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

test('the workflow trigger route refuses both agent-only types with its sentence', async () => {
  assert.deepEqual([...UNRELEASED_TRIGGER_TYPES], [], 'no agent trigger type is left unreleased')
  const app = buildApp()
  try {
    for (const type of ['ticket_changed', 'document_changed'] as const) {
      const refusal = workflowTriggerTypeRefusal(type)
      assert.ok(refusal, `a workflow refuses ${type}`)
      const response = await app.inject({
        method: 'POST',
        payload: { type },
        url: `/api/workflow-installations/${INSTALLATION_ID}/triggers`,
      })
      assert.equal(response.statusCode, 400, type)
      const body = response.json() as { error: { code: string; message: string } }
      assert.equal(body.error.code, 'TRIGGER_TYPE_UNAVAILABLE')
      assert.equal(body.error.message, refusal)
    }
  } finally {
    await app.close()
  }
})
