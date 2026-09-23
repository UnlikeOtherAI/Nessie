import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { AgentCardSpecSchema } from '@nessie/schemas'
import { AGENT_DESIGNER_BLUEPRINT, AGENT_DESIGNER_SLUG, ensureGlobalAgentBootstrap } from '@nessie/team-admin'

import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { RunContext } from '../../src/run/execute/types.js'
import {
  runExecutorAgentGrantPrepareTool,
  runExecutorLifecyclePrepareTool,
} from '../../src/run/pa-tools/executors.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

/**
 * F6: the Designer's executor grant must be confirmable from chat.
 *
 * `executor_agent_grant_prepare` used to answer with a review link carrying
 * `#confirmationToken=<token>`. The model never saw that token — the secret
 * scanner redacts every tool result, rightly — so the link it posted opened a
 * review that could not confirm. The tool now posts a system-authored
 * confirmation card in the requester's own home DM that stores only the
 * change's id; the press mints the token (api `agent-card-response.ts`).
 *
 * Against real rows, from the Designer's bootstrapped home DM: what the model
 * reads, what the card row holds, and what the message says.
 */

type Seed = {
  agentId: string
  executorId: string
  home: { dmKey: string | null; id: string; projectId: string; teamId: string }
  organizationId: string
  ownerId: string
  runId: string
  targetAgentId: string
  threadId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `executor-review-card-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `executor-review-card-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: owner.id },
  })
  const project = await prisma.project.create({ data: { name: `project-${suffix}`, organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const bootstrap = await ensureGlobalAgentBootstrap(prisma, {
    blueprint: AGENT_DESIGNER_BLUEPRINT,
    organizationId: organization.id,
    teamId: team.id,
    userId: owner.id,
  })
  const home = await prisma.channel.findUniqueOrThrow({
    where: { id: bootstrap.channelId },
    select: { dmKey: true, id: true, projectId: true, teamId: true, threads: { select: { id: true } } },
  })
  const threadId = home.threads[0]?.id
  assert.ok(threadId, 'the home DM has its default thread')
  const run = await prisma.run.create({
    data: { agentId: bootstrap.agentId, status: 'running', threadId },
  })
  const target = await prisma.agent.create({
    data: { name: 'CTO', organizationId: organization.id, projectId: project.id, teamId: team.id },
  })
  const executor = await prisma.executor.create({
    data: {
      label: 'Minis',
      lastSeenAt: new Date(),
      organizationId: organization.id,
      pairingOwnerUserId: owner.id,
      privateAssignments: { create: { principalKind: 'user', role: 'admin', userId: owner.id } },
      profiles: ['workspace_sandbox'],
      scopeKind: 'private',
      status: 'online',
    },
  })
  return {
    agentId: bootstrap.agentId,
    executorId: executor.id,
    home: { dmKey: home.dmKey, id: home.id, projectId: home.projectId, teamId: home.teamId },
    organizationId: organization.id,
    ownerId: owner.id,
    runId: run.id,
    targetAgentId: target.id,
    threadId,
  }
}

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.executor.deleteMany({ where: { id: s.executorId } })
  await prisma.organization.deleteMany({ where: { id: s.organizationId } })
  await prisma.user.deleteMany({ where: { id: s.ownerId } })
}

/** The Designer, on an interactive turn in its own home DM, acting as its member. */
const designerContext = (prisma: PrismaClient, s: Seed): BuiltinToolRuntimeContext => {
  const consumedSources = createConsumedSourceSink()
  const runContext: RunContext = {
    agent: {
      agentKind: 'shared',
      effort: 'medium',
      executionMode: 'inference',
      id: s.agentId,
      model: null,
      name: 'Agent Designer',
      parentAgentId: null,
      provider: null,
      systemPrompt: null,
      systemSlug: AGENT_DESIGNER_SLUG,
    },
    boundAgentIds: [],
    channel: {
      dmKey: s.home.dmKey,
      id: s.home.id,
      organizationId: s.organizationId,
      projectId: s.home.projectId,
      systemChannelType: 'system_agent',
      teamId: s.home.teamId,
      visibility: 'private',
    },
    consumedSources,
    run: { createdAt: new Date(), id: s.runId, replyPlacement: null, threadId: s.threadId },
    task: { id: randomUUID() },
  }
  return {
    actorContext: {
      actionContext: { effectiveUserId: s.ownerId, requestId: randomUUID() },
      actor: { actorId: s.ownerId, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId: s.organizationId, projectId: s.home.projectId, teamId: s.home.teamId },
    },
    agentId: s.agentId,
    agentKind: 'shared',
    channel: { id: s.home.id, organizationId: s.organizationId, systemChannelType: 'system_agent' },
    consumedSources,
    ledgerIdentity: null,
    prisma,
    realtimeTransport: { publishWs: async () => undefined },
    run: {
      id: s.runId,
      interactive: true,
      messageId: randomUUID(),
      originatingUserId: s.ownerId,
      threadId: s.threadId,
    },
    runContext,
    toolCallId: randomUUID(),
  } as unknown as BuiltinToolRuntimeContext
}

// A confirmation token is 32 random bytes in base64url: 43 characters.
const TOKEN_SHAPE = /[A-Za-z0-9_-]{43}/

runDatabaseTest('a prepared grant posts a review card that holds only the change id', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => cleanup(prisma, s).then(() => prisma.$disconnect()))

  const result = await runExecutorAgentGrantPrepareTool(designerContext(prisma, s), {
    agentId: s.targetAgentId,
    executorId: s.executorId,
    state: 'allowed',
  })

  // What the model reads: that a card was posted, and no secret at all.
  assert.match(result.outputPreview, /put a confirmation card in this conversation/)
  assert.match(result.outputPreview, /with fresh account verification/)
  assert.doesNotMatch(result.outputPreview, /confirmationToken|#|\/agents\/executors/)
  assert.doesNotMatch(result.outputPreview.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/, ''), TOKEN_SHAPE)
  assert.equal(result.deliveredToConversation, true)

  const continuation = await prisma.executorContinuation.findFirstOrThrow({
    where: { executorId: s.executorId },
    select: { expiresAt: true, id: true, status: true },
  })
  assert.equal(continuation.status, 'pending')

  const card = await prisma.agentCard.findFirstOrThrow({
    where: { threadId: s.threadId },
    select: {
      channelId: true,
      executorAccessChangeId: true,
      expiresAt: true,
      message: { select: { content: true, metadata: true, role: true } },
      respondentUserIds: true,
      spec: true,
      waitRunId: true,
    },
  })
  // The requester's own DM, answerable by them alone, for as long as the change lives.
  assert.equal(card.channelId, s.home.id)
  assert.equal(card.executorAccessChangeId, continuation.id)
  assert.deepEqual(card.respondentUserIds, [s.ownerId])
  assert.equal(card.expiresAt?.getTime(), continuation.expiresAt.getTime())
  assert.equal(card.waitRunId, null, 'the run does not park on it: the review is the person\'s')

  const spec = AgentCardSpecSchema.parse(card.spec)
  assert.equal(spec.title, 'Confirm an executor change')
  assert.equal(spec.subtitle, 'Give an agent access to this executor')
  assert.deepEqual(spec.actions, [{ key: 'review', label: 'Review', style: 'primary', submits: true }])
  assert.match(JSON.stringify(spec.blocks), /Nothing is applied until you confirm it there, with your password/)
  // Server-written copy: nothing in the card or its message is a way in.
  for (const text of [JSON.stringify(card.spec), card.message.content, JSON.stringify(card.message.metadata)]) {
    assert.doesNotMatch(text, /confirmationToken|accessChange=/)
  }
  assert.equal(card.message.role, 'assistant')
})

runDatabaseTest('every prepared access change is confirmed through the same card', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => cleanup(prisma, s).then(() => prisma.$disconnect()))

  const result = await runExecutorLifecyclePrepareTool(designerContext(prisma, s), {
    action: 'pause',
    executorId: s.executorId,
  })
  assert.doesNotMatch(result.outputPreview, /confirmationToken|fresh account verification/)

  const card = await prisma.agentCard.findFirstOrThrow({
    where: { threadId: s.threadId },
    select: { executorAccessChangeId: true, spec: true },
  })
  assert.ok(card.executorAccessChangeId)
  const spec = AgentCardSpecSchema.parse(card.spec)
  assert.equal(spec.subtitle, 'Pause this executor')
  assert.doesNotMatch(JSON.stringify(spec.blocks), /password/)
})
