import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { continueRun } from '../src/services/run-continuation.js'
import { requestRunCancellation, restartRun } from '../src/services/runs.js'

/**
 * Cancel, restart and continue take the same entitlement the run *list* takes.
 *
 * Against a real database because every arm is a database fact — the channel
 * membership row, the channel's visibility, and the agent's own privacy fence.
 * A cast Prisma fake would assert the shape of the `where` rather than that a
 * member holding a bare run UUID is actually refused.
 *
 * Seed-scoped throughout: the database is shared with the other suites running
 * concurrently, so nothing here deletes or counts globally.
 */

const suite = 'a4c1'
const orgId = `00000000-0000-4000-8000-${suite}00000001`
const projectId = `00000000-0000-4000-8000-${suite}00000002`
const teamId = `00000000-0000-4000-8000-${suite}00000003`
const privateChannelId = `00000000-0000-4000-8000-${suite}00000004`
const publicChannelId = `00000000-0000-4000-8000-${suite}00000005`
const privateThreadId = `00000000-0000-4000-8000-${suite}00000006`
const publicThreadId = `00000000-0000-4000-8000-${suite}00000007`
const teamAgentId = `00000000-0000-4000-8000-${suite}00000008`
const privateAgentId = `00000000-0000-4000-8000-${suite}00000009`

const insiderUserId = `00000000-0000-4000-8000-${suite}00000010`
const outsiderUserId = `00000000-0000-4000-8000-${suite}00000011`

const userIds = [insiderUserId, outsiderUserId]

const dbTest = process.env.DATABASE_URL ? test : test.skip

const actorFor = (userId: string): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles: ['member'] },
  tenant: {
    organizationId: parseOrganizationId(orgId),
    projectId: parseProjectId(projectId),
    teamId: parseTeamId(teamId),
  },
  actionContext: {
    requestId: `req-run-access-${userId}`,
    teamId: parseTeamId(teamId),
  },
})

const seed = async (prisma: PrismaClient) => {
  await prisma.organization.create({ data: { id: orgId, name: `run-access-${suite}` } })
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({
      displayName: `Run access ${index}`,
      email: `run-access-${suite}-${index}@test.local`,
      id,
    })),
  })
  // Both are ordinary members of the same organisation. That is exactly the
  // reach the old org-only scoping treated as sufficient.
  await prisma.organizationMember.createMany({
    data: userIds.map((userId) => ({ organizationId: orgId, role: 'member', userId })),
  })
  await prisma.project.create({ data: { id: projectId, name: `p-${suite}`, organizationId: orgId } })
  await prisma.team.create({ data: { id: teamId, name: `t-${suite}`, projectId } })
  await prisma.channel.createMany({
    data: [
      {
        id: privateChannelId,
        label: `priv-${suite}`,
        organizationId: orgId,
        projectId,
        slug: `priv-${suite}`,
        teamId,
        visibility: 'private',
      },
      {
        id: publicChannelId,
        label: `pub-${suite}`,
        organizationId: orgId,
        projectId,
        slug: `pub-${suite}`,
        teamId,
        visibility: 'public',
      },
    ],
  })
  await prisma.channelMember.create({
    data: { channelId: privateChannelId, userId: insiderUserId, role: 'owner' },
  })
  await prisma.thread.createMany({
    data: [
      { id: privateThreadId, channelId: privateChannelId },
      { id: publicThreadId, channelId: publicChannelId },
    ],
  })
  await prisma.agent.create({
    data: { id: teamAgentId, name: `team-${suite}`, organizationId: orgId, visibility: 'team' },
  })
  // A private agent its steward alone may see, working in a channel everybody
  // in the organisation can read.
  await prisma.agent.create({
    data: {
      id: privateAgentId,
      name: `private-${suite}`,
      organizationId: orgId,
      ownerUserId: insiderUserId,
      visibility: 'private',
    },
  })
}

const cleanup = async (prisma: PrismaClient) => {
  await prisma
    .$executeRaw`DELETE FROM queue_jobs WHERE payload->>'threadId' IN (${privateThreadId}, ${publicThreadId})`
    .catch(() => undefined)
  await prisma.taskEvent.deleteMany({ where: { task: { organizationId: orgId } } })
  await prisma.task.deleteMany({ where: { organizationId: orgId } })
  await prisma.runCheckpoint.deleteMany({ where: { organizationId: orgId } })
  await prisma.run.deleteMany({ where: { threadId: { in: [privateThreadId, publicThreadId] } } })
  await prisma.message.deleteMany({ where: { threadId: { in: [privateThreadId, publicThreadId] } } })
  await prisma.thread.deleteMany({ where: { id: { in: [privateThreadId, publicThreadId] } } })
  await prisma.channelMember.deleteMany({
    where: { channelId: { in: [privateChannelId, publicChannelId] } },
  })
  await prisma.channel.deleteMany({
    where: { id: { in: [privateChannelId, publicChannelId] } },
  })
  await prisma.agent.deleteMany({ where: { organizationId: orgId } })
  await prisma.team.deleteMany({ where: { id: teamId } })
  await prisma.project.deleteMany({ where: { id: projectId } })
  await prisma.organizationMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
}

const withDb = async (run: (prisma: PrismaClient) => Promise<void>) => {
  const prisma = new PrismaClient()
  try {
    await cleanup(prisma)
    await seed(prisma)
    await run(prisma)
  } finally {
    await cleanup(prisma)
    await prisma.$disconnect()
  }
}

const createRun = async (
  prisma: PrismaClient,
  input: {
    agentId: string
    checkpoint?: boolean
    status: 'running' | 'failed'
    threadId: string
  },
) => {
  const message = await prisma.message.create({
    data: {
      content: 'do the thing',
      role: 'user',
      threadId: input.threadId,
      userId: insiderUserId,
    },
  })
  const run = await prisma.run.create({
    data: {
      agentId: input.agentId,
      status: input.status,
      threadId: input.threadId,
      triggerMessageId: message.id,
    },
  })
  await prisma.task.create({
    data: { agentId: input.agentId, organizationId: orgId, runId: run.id, status: 'inbox' },
  })
  if (input.checkpoint) {
    await prisma.runCheckpoint.create({
      data: {
        agentId: input.agentId,
        generation: 1,
        note: 'Working notes from the stopped run.',
        organizationId: orgId,
        reason: 'token_limit',
        runId: run.id,
        sources: [],
        threadId: input.threadId,
      },
    })
  }
  return run
}

dbTest('cancel: a member outside the run\'s private channel cannot stop it', async () => {
  await withDb(async (prisma) => {
    const run = await createRun(prisma, {
      agentId: teamAgentId,
      status: 'running',
      threadId: privateThreadId,
    })

    const refused = await requestRunCancellation(prisma, {
      cancelledByUserId: outsiderUserId,
      organizationId: orgId,
      runId: run.id,
    })
    assert.deepEqual(refused, { kind: 'not_found' })
    const untouched = await prisma.run.findUnique({ where: { id: run.id } })
    assert.equal(untouched?.cancelRequestedAt, null)

    const allowed = await requestRunCancellation(prisma, {
      cancelledByUserId: insiderUserId,
      organizationId: orgId,
      runId: run.id,
    })
    assert.equal(allowed.kind, 'cancel_requested')
  })
})

dbTest('cancel: a private agent working in a public channel is not another member\'s to stop', async () => {
  await withDb(async (prisma) => {
    const run = await createRun(prisma, {
      agentId: privateAgentId,
      status: 'running',
      threadId: publicThreadId,
    })

    const refused = await requestRunCancellation(prisma, {
      cancelledByUserId: outsiderUserId,
      organizationId: orgId,
      runId: run.id,
    })
    assert.deepEqual(refused, { kind: 'not_found' })

    const allowed = await requestRunCancellation(prisma, {
      cancelledByUserId: insiderUserId,
      organizationId: orgId,
      runId: run.id,
    })
    assert.equal(allowed.kind, 'cancel_requested')
  })
})

dbTest('restart: a member outside the run\'s private channel cannot replay it', async () => {
  await withDb(async (prisma) => {
    const run = await createRun(prisma, {
      agentId: teamAgentId,
      status: 'failed',
      threadId: privateThreadId,
    })

    const refused = await restartRun(prisma, actorFor(outsiderUserId), {
      organizationId: orgId,
      runId: run.id,
    })
    assert.deepEqual(refused, { kind: 'not_found' })
    assert.equal(await prisma.run.count({ where: { restartOfRunId: run.id } }), 0)

    const allowed = await restartRun(prisma, actorFor(insiderUserId), {
      organizationId: orgId,
      runId: run.id,
    })
    assert.equal(allowed.kind, 'restarted')
    assert.equal(await prisma.run.count({ where: { restartOfRunId: run.id } }), 1)
  })
})

dbTest('continue: a member outside the run\'s private channel cannot resume its checkpoint', async () => {
  await withDb(async (prisma) => {
    const run = await createRun(prisma, {
      agentId: teamAgentId,
      checkpoint: true,
      status: 'failed',
      threadId: privateThreadId,
    })

    const refused = await continueRun(prisma, actorFor(outsiderUserId), {
      organizationId: orgId,
      runId: run.id,
    })
    assert.deepEqual(refused, { kind: 'not_found' })
    const unclaimed = await prisma.runCheckpoint.findUnique({ where: { runId: run.id } })
    assert.equal(unclaimed?.consumedByRunId, null)

    const allowed = await continueRun(prisma, actorFor(insiderUserId), {
      organizationId: orgId,
      runId: run.id,
    })
    assert.equal(allowed.kind, 'continued')
    const claimed = await prisma.runCheckpoint.findUnique({ where: { runId: run.id } })
    assert.ok(claimed?.consumedByRunId)
  })
})
