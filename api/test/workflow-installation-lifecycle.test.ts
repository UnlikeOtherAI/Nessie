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

import { dispatchAgentTrigger } from '../src/services/trigger-dispatch.js'
import { retryWorkflowRun } from '../src/services/workflow-runs.js'
import {
  installWorkflowTemplate,
  updateWorkflowInstallation,
  WorkflowInstallationLifecycleError,
} from '../src/services/workflow-templates.js'

// W8: `paused` must actually pause, and become reachable. Dispatch gates on
// the exact active status; the update endpoint derives one lifecycle and
// rejects contradictory active/status pairs.
// W27: retry preserves the original starter and records the retrying actor.
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

type Seed = Awaited<ReturnType<typeof seedWorkspace>>

const seedWorkspace = async (prisma: PrismaClient) => {
  const org = await prisma.organization.create({
    data: { name: `wf-lifecycle ${randomUUID()}` },
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
    data: { displayName: 'Owner', email: `wf-life-${randomUUID()}@example.com` },
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

runDatabaseTest('W8: paused installations do not fire; the update endpoint drives the lifecycle', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })
  const actorContext = ownerContext(seed)

  const installation = await installWorkflowTemplate(prisma, actorContext, seed.templateId, {
    channelId: seed.channelId,
  })
  assert.ok(installation)
  assert.equal(installation.status, 'active')

  const trigger = await prisma.agentTrigger.create({
    data: { type: 'interval', workflowInstallationId: installation.id },
  })

  const loadTrigger = () =>
    prisma.agentTrigger.findUnique({
      where: { id: trigger.id },
      include: { workflowInstallation: true },
    })

  const fire = () =>
    dispatchAgentTrigger(prisma, {
      dedupeKey: `d-${randomUUID()}`,
      payload: { n: 1 },
      source: 'test',
      triggerId: trigger.id,
      loadTrigger,
    } as never)

  // Active fires.
  const first = await fire()
  assert.equal(first.kind, 'queued')

  // Pausing via the new update endpoint stops dispatch.
  const paused = await updateWorkflowInstallation(prisma, actorContext, installation.id, {
    status: 'paused',
  })
  assert.equal(paused?.status, 'paused')
  assert.equal(paused?.active, false)
  const second = await fire()
  assert.equal(second.kind, 'rejected')

  // Resume restores dispatch.
  const resumed = await updateWorkflowInstallation(prisma, actorContext, installation.id, {
    status: 'active',
  })
  assert.equal(resumed?.status, 'active')
  assert.equal(resumed?.active, true)
  const third = await fire()
  assert.equal(third.kind, 'queued')

  // Disabled never fires, even though callers only used to check `disabled`.
  const disabled = await updateWorkflowInstallation(prisma, actorContext, installation.id, {
    status: 'disabled',
  })
  assert.equal(disabled?.status, 'disabled')
  const fourth = await fire()
  assert.equal(fourth.kind, 'rejected')

  // Contradictory active/status combinations are rejected, on install too.
  await assert.rejects(
    updateWorkflowInstallation(prisma, actorContext, installation.id, {
      active: true,
      status: 'paused',
    }),
    WorkflowInstallationLifecycleError,
  )
  await assert.rejects(
    updateWorkflowInstallation(prisma, actorContext, installation.id, {
      active: false,
      status: 'active',
    }),
    WorkflowInstallationLifecycleError,
  )
  await assert.rejects(
    installWorkflowTemplate(prisma, actorContext, seed.templateId, {
      active: false,
      status: 'active',
    }),
    WorkflowInstallationLifecycleError,
  )
})

runDatabaseTest('W27: retry preserves the original starter and records the retrying actor', async (t) => {
  const prisma = new PrismaClient()
  const seed = await seedWorkspace(prisma)
  t.after(async () => {
    await cleanup(prisma, seed)
    await prisma.$disconnect()
  })
  const actorContext = ownerContext(seed)

  const installation = await installWorkflowTemplate(prisma, actorContext, seed.templateId, {
    channelId: seed.channelId,
  })
  assert.ok(installation)

  const original = await prisma.workflowRun.create({
    data: {
      installationId: installation.id,
      organizationId: seed.organizationId,
      status: 'failed',
      startedByActorId: 'original-starter',
      startedByActorType: 'service',
    },
  })

  const retried = await retryWorkflowRun(prisma, actorContext, original.id, {})
  assert.ok(retried)
  // The original actor is NOT overwritten by the retrying owner.
  assert.equal(retried.startedByActorId, 'original-starter')
  assert.equal(retried.startedByActorType, 'service')

  const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: retried.id } })
  assert.equal(row.retriedFromWorkflowRunId, original.id)
  assert.equal(row.retriedByActorId, seed.ownerId)
  assert.equal(row.retriedByActorType, 'user')
  assert.ok(row.retriedAt)
})
