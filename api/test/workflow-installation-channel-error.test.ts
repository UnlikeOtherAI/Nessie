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
import Fastify, { type FastifyInstance } from 'fastify'

import { registerWorkflowInstallationRoutes } from '../src/routes/workflows/installations.js'
import {
  WORKFLOW_REFERENCE_ERROR_CODES,
  WorkflowReferenceError,
} from '../src/services/workflow-references.js'
import {
  installWorkflowTemplate,
  updateWorkflowInstallation,
} from '../src/services/workflow-templates.js'

// S2-errors F4: `WorkflowReferenceError` replaced a bare
// `throw new Error('WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND')` that the route
// matched with `error.message === '...'`. These tests prove (a) the service
// throws the typed class with the same code, (b) the route still answers
// 404/WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND unchanged over HTTP, and (c)
// the match no longer depends on the message text at all — the point of the
// fix: a reworded message cannot turn this into an unhandled 500, and a
// look-alike plain `Error` with the old message text is no longer mistaken
// for it.

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
    data: { name: `wf-channel-error ${randomUUID()}` },
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
    data: { displayName: 'Owner', email: `wf-channel-error-${randomUUID()}@example.com` },
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
  'updateWorkflowInstallation throws the typed WorkflowReferenceError for an unknown channel',
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

    await assert.rejects(
      () =>
        updateWorkflowInstallation(prisma, actorContext, installation.id, {
          channelId: randomUUID(),
        }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowReferenceError)
        assert.equal(error.code, WORKFLOW_REFERENCE_ERROR_CODES.CHANNEL_NOT_FOUND)
        return true
      },
    )
  },
)

runDatabaseTest(
  'PATCH /api/workflow-installations/:id still answers 404 WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND over HTTP',
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
      method: 'PATCH',
      payload: { channelId: randomUUID() },
      url: `/api/workflow-installations/${installation.id}`,
    })

    assert.equal(response.statusCode, 404)
    const body = response.json() as { error?: { code?: string } }
    assert.equal(body.error?.code, 'WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND')
  },
)

test('the route matches WorkflowReferenceError by code, not by message text', () => {
  // Renaming the thrown message must not change how the route dispatches it:
  // `instanceof` + `.code` still resolve, unlike the old `error.message ===
  // 'WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND'` check this replaced.
  const renamed = new WorkflowReferenceError(
    WORKFLOW_REFERENCE_ERROR_CODES.CHANNEL_NOT_FOUND,
    'Totally reworded copy that shares no words with the old constant',
  )
  const matches = (error: unknown): boolean =>
    error instanceof WorkflowReferenceError
    && error.code === WORKFLOW_REFERENCE_ERROR_CODES.CHANNEL_NOT_FOUND
  assert.equal(matches(renamed), true)

  // And a look-alike plain `Error` carrying the *old* message-as-code string
  // — exactly what a stringly-typed throw used to produce — is no longer
  // mistaken for the typed error, because the check no longer reads `.message`.
  const impostor = new Error('WORKFLOW_INSTALLATION_CHANNEL_NOT_FOUND')
  assert.equal(matches(impostor), false)
})
