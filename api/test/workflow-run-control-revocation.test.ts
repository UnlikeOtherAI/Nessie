import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { registerWorkflowRunRoutes } from '../src/routes/workflows/runs.js'

const workflowRunId = '00000000-0000-4000-8000-000000000010'
const organizationId = '00000000-0000-4000-8000-000000000011'
const actorId = '00000000-0000-4000-8000-000000000012'

const actorContext = (roles: string[]): AuthorizedActionContext => ({
  actionContext: { requestId: 'workflow-control-revocation-test' },
  actor: { actorId, actorType: 'user', roles },
  tenant: { organizationId },
})

test('a workflow control is rejected when administration is revoked after the detail rendered', async () => {
  let currentActor = actorContext(['admin'])
  const app = Fastify({ logger: false })
  registerWorkflowRunRoutes(app, {
    prisma: {} as PrismaClient,
    requireActorContext: () => currentActor,
  } as Parameters<typeof registerWorkflowRunRoutes>[1])

  // The UI's earlier effective-admin decision is intentionally stale here.
  // Mutations must read the current actor context at the route boundary.
  currentActor = actorContext(['member'])
  const response = await app.inject({
    method: 'POST',
    payload: {},
    url: `/api/workflow-runs/${workflowRunId}/cancel`,
  })

  assert.equal(response.statusCode, 403)
  assert.equal(response.json().error.code, 'FORBIDDEN')
  await app.close()
})
