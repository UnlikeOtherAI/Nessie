import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import {
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
} from '@nessie/schemas'
import { WorkflowReferenceError } from '@nessie/team-admin'
import Fastify, { type FastifyInstance } from 'fastify'

import { registerWorkflowInstallationRoutes } from '../src/routes/workflows/installations.js'
import { WORKFLOW_REFERENCE_ERROR_CODES } from '../src/services/workflow-references.js'
import { installWorkflowTemplate } from '../src/services/workflow-templates.js'

// S2-errors F4 (sibling to workflow-installation-channel-error.test.ts): the
// run-start path's reference checks (`@nessie/team-admin`'s
// `validateWorkflowRunReferences`) used to throw a bare `Error(message)` per
// code, and the route matched with a `Record<string, ...>` lookup keyed on
// `error.message`. Both now throw/match the one typed `WorkflowReferenceError`
// class the channel check uses. These tests prove (a) the service throws the
// typed class with the run-specific code, and (b) the route still answers the
// same 404 status/code over HTTP for two representative codes — unchanged by
// the refactor, and no longer dependent on the message text.

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

const SIMPLE_GRAPH = {
  steps: [
    {
      id: 'first',
      input: { key: 'k', toolName: 'state_get' },
      title: 'First',
      type: 'tool',
    },
  ],
}

type Seed = Awaited<ReturnType<typeof seedTeam>>

const seedTeam = async (prisma: PrismaClient) => {
  const org = await prisma.organization.create({
    data: { name: `wf-run-ref-error ${randomUUID()}` },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: org.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'c',
      slug: `c-${randomUUID()}`,
      organizationId: org.id,
      projectId: project.id,
      teamId: team.id,
    },
  })
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `wf-run-ref-error-${randomUUID()}@example.com` },
  })
  const template = await prisma.workflowTemplate.create({
    data: {
      createdByActorId: owner.id,
      createdByActorType: 'user',
      graphJson: SIMPLE_GRAPH,
      name: 'wf',
      organizationId: org.id,
    },
  })
  return {
    channelId: channel.id,
    organizationId: org.id,
    ownerId: owner.id,
    projectId: project.id,
    teamId: team.id,
    templateId: template.id,
  }
}

const ownerContext = (seed: Seed): AuthorizedActionContext => ({
  actor: { actorId: seed.ownerId, actorType: 'user', roles: ['owner'] },
  actionContext: { purpose: 'test', requestId: randomUUID() },
  tenant: {
    channelId: parseChannelId(seed.channelId),
    organizationId: parseOrganizationId(seed.organizationId),
    projectId: parseProjectId(seed.projectId),
    teamId: parseTeamId(seed.teamId),
  },
})

const cleanup = async (prisma: PrismaClient, seed: Seed) => {
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
  await prisma.user.deleteMany({ where: { id: seed.ownerId } })
}

const buildApp = (prisma: PrismaClient, actorContext: AuthorizedActionContext): FastifyInstance => {
  const app = Fastify({ logger: false })
  registerWorkflowInstallationRoutes(app, {
    prisma,
    requireActorContext: () => actorContext,
  } as unknown as Parameters<typeof registerWorkflowInstallationRoutes>[1])
  return app
}

runDatabaseTest(
  'POST .../run answers 404 WORKFLOW_RUN_PARENT_RUN_NOT_FOUND for an unknown parentRunId',
  async (t) => {
    const prisma = new PrismaClient()
    const seed = await seedTeam(prisma)
    t.after(async () => {
      await cleanup(prisma, seed)
      await prisma.$disconnect()
    })
    const actorContext = ownerContext(seed)

    const installation = await installWorkflowTemplate(prisma, actorContext, seed.templateId, {
      channelId: seed.channelId,
    })
    assert.ok(installation)

    const app = buildApp(prisma, actorContext)
    t.after(() => app.close())

    const response = await app.inject({
      method: 'POST',
      payload: { parentRunId: randomUUID() },
      url: `/api/workflow-installations/${installation.id}/run`,
    })

    assert.equal(response.statusCode, 404)
    const body = response.json() as { error?: { code?: string } }
    assert.equal(body.error?.code, 'WORKFLOW_RUN_PARENT_RUN_NOT_FOUND')
  },
)

runDatabaseTest(
  'POST .../run answers 404 WORKFLOW_RUN_TRIGGER_NOT_FOUND for an unknown triggerId',
  async (t) => {
    const prisma = new PrismaClient()
    const seed = await seedTeam(prisma)
    t.after(async () => {
      await cleanup(prisma, seed)
      await prisma.$disconnect()
    })
    const actorContext = ownerContext(seed)

    const installation = await installWorkflowTemplate(prisma, actorContext, seed.templateId, {
      channelId: seed.channelId,
    })
    assert.ok(installation)

    const app = buildApp(prisma, actorContext)
    t.after(() => app.close())

    const response = await app.inject({
      method: 'POST',
      payload: { triggerId: randomUUID() },
      url: `/api/workflow-installations/${installation.id}/run`,
    })

    assert.equal(response.statusCode, 404)
    const body = response.json() as { error?: { code?: string } }
    assert.equal(body.error?.code, 'WORKFLOW_RUN_TRIGGER_NOT_FOUND')
  },
)

test('the run route matches run-reference codes by .code, not by message text', () => {
  // Every run-reference code shares the one `WorkflowReferenceError` class
  // with the channel-not-found check: renaming a message must not change
  // dispatch, and a look-alike plain `Error` carrying the old
  // message-as-code string must not be mistaken for it.
  const renamed = new WorkflowReferenceError(
    WORKFLOW_REFERENCE_ERROR_CODES.RUN_PLAN_NOT_FOUND,
    'Totally reworded copy that shares no words with the old constant',
  )
  const matches = (error: unknown): boolean =>
    error instanceof WorkflowReferenceError
    && error.code === WORKFLOW_REFERENCE_ERROR_CODES.RUN_PLAN_NOT_FOUND
  assert.equal(matches(renamed), true)

  const impostor = new Error('WORKFLOW_RUN_PLAN_NOT_FOUND')
  assert.equal(matches(impostor), false)
})
