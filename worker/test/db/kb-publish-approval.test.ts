import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { TooManyPendingApprovalsError } from '@nessie/team-admin'

import { runKbPublishRequestTool } from '../../src/run/pa-tools/knowledge-write.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { deleteThreadQueueJobs, runDatabaseTest } from './support.js'

/**
 * The `kb_publish_request` door against a real database.
 *
 * Both properties pinned here only exist in Postgres. The race test needs the
 * advisory lock the shared creator takes — against the pre-shared door (an
 * unlocked find-then-create with no transaction) concurrent asks for one
 * draft version open two approvals, which is exactly what this test catches:
 * it FAILS against that implementation. The ceiling test needs the pending
 * count the creator takes inside the same lock.
 */

type Seed = {
  agentId: string
  channelId: string
  organizationId: string
  pageId: string
  projectId: string
  runId: string
  teamId: string
  threadId: string
  userId: string
  versionId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `kb-publish-${suffix}` },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Reviewer', email: `kb-publish-${suffix}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: 'p', organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'work',
      members: { create: [{ userId: user.id }] },
      organizationId: organization.id,
      projectId: project.id,
      slug: `kb-publish-${suffix}`,
      teamId: team.id,
      visibility: 'private',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const agent = await prisma.agent.create({
    data: { agentKind: 'shared', name: `Author ${suffix}`, organizationId: organization.id },
  })
  // The binding is what makes the agent org-bound for space visibility.
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'running', threadId: thread.id },
  })
  const space = await prisma.knowledgeSpace.create({
    data: {
      createdBy: user.id,
      name: 'Handbook',
      organizationId: organization.id,
      projectId: project.id,
      visibility: 'organization',
    },
  })
  const page = await prisma.knowledgePage.create({
    data: {
      createdBy: agent.id,
      organizationId: organization.id,
      projectId: project.id,
      spaceId: space.id,
      status: 'draft',
      title: 'Runbook',
      visibility: 'organization',
    },
  })
  const version = await prisma.knowledgePageVersion.create({
    data: {
      authorId: agent.id,
      authorType: 'agent',
      body: '<p>Ship on Tuesdays.</p>',
      pageId: page.id,
      versionNumber: 1,
    },
  })
  return {
    agentId: agent.id,
    channelId: channel.id,
    organizationId: organization.id,
    pageId: page.id,
    projectId: project.id,
    runId: run.id,
    teamId: team.id,
    threadId: thread.id,
    userId: user.id,
    versionId: version.id,
  }
}

const cleanup = async (prisma: PrismaClient, s: Seed) => {
  await deleteThreadQueueJobs(prisma, s.threadId)
  await prisma.organization.delete({ where: { id: s.organizationId } })
  await prisma.user.delete({ where: { id: s.userId } }).catch(() => undefined)
  await prisma.$disconnect()
}

const contextFor = (prisma: PrismaClient, s: Seed): BuiltinToolRuntimeContext =>
  ({
    agentId: s.agentId,
    agentKind: 'shared',
    actorContext: {
      actor: { actorId: s.agentId, actorType: 'agent', roles: [] },
      actionContext: { requestId: randomUUID() },
      tenant: { organizationId: s.organizationId, teamId: s.teamId },
    },
    channel: { id: s.channelId, organizationId: s.organizationId, systemChannelType: null },
    prisma,
    realtimeTransport: { publishWs: async () => undefined },
    run: {
      id: s.runId,
      messageId: 'message-1',
      originatingUserId: s.userId,
      threadId: s.threadId,
    },
  }) as unknown as BuiltinToolRuntimeContext

runDatabaseTest('concurrent publish requests for one draft version open ONE approval', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    // Two clients rather than one: separate connections are the closer model
    // of two runs racing, and cost nothing. Without the shared creator's
    // advisory lock the unlocked check-then-create loses this race — the
    // window between the findMany and the create is a network round-trip
    // wide, and eight callers fall through it together.
    const other = new PrismaClient()
    const asks = Array.from({ length: 8 }, (_, index) =>
      runKbPublishRequestTool(
        contextFor(index % 2 === 0 ? prisma : other, s),
        { pageId: s.pageId },
      ))
    const results = await Promise.all(asks).finally(() => other.$disconnect())

    const mentioned = results.map((result) => result.outputPreview.match(/approval (\S+) /)?.[1])
    assert.ok(mentioned.every((id) => id), 'every call reports an approval id')
    assert.equal(new Set(mentioned).size, 1, 'a race must not open two decisions')
    const count = await prisma.approvalRequest.count({
      where: { action: 'knowledge.page.publish', organizationId: s.organizationId },
    })
    assert.equal(count, 1, 'exactly one approval survived the race')

    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { organizationId: s.organizationId },
    })
    const context = approval.context as Record<string, unknown>
    assert.equal(context['pageId'], s.pageId)
    assert.equal(context['versionId'], s.versionId)
  } finally {
    await cleanup(prisma, s)
  }
})

runDatabaseTest('the publish door respects the per-requester pending ceiling', async () => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  try {
    // Ten genuinely distinct pending requests from this agent — the pile the
    // ceiling exists to stop. The pre-shared door had no ceiling at all, so
    // this test fails against it by happily opening an eleventh.
    await prisma.approvalRequest.createMany({
      data: Array.from({ length: 10 }, () => ({
        action: 'knowledge.page.publish',
        agentId: s.agentId,
        continuationToken: randomUUID(),
        context: { pageId: randomUUID(), versionId: randomUUID() },
        expiresAt: new Date(Date.now() + 86_400_000),
        organizationId: s.organizationId,
        reason: 'Please publish',
        requesterId: s.agentId,
      })),
    })

    await assert.rejects(
      () => runKbPublishRequestTool(contextFor(prisma, s), { pageId: s.pageId }),
      (error: unknown) => {
        assert.ok(error instanceof TooManyPendingApprovalsError)
        return true
      },
    )
    const count = await prisma.approvalRequest.count({
      where: { agentId: s.agentId, organizationId: s.organizationId },
    })
    assert.equal(count, 10, 'a refused ask opens nothing')
  } finally {
    await cleanup(prisma, s)
  }
})
