import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { AT_REST_SECRET_PURPOSE, encryptWithKeyRing, toEncryptionKeyRing } from '@nessie/runtime'
import { AgentCardSpecSchema, ExecutorCapabilityDescriptorSchema } from '@nessie/schemas'
import { AGENT_DESIGNER_BLUEPRINT, AGENT_DESIGNER_SLUG, ensureGlobalAgentBootstrap } from '@nessie/team-admin'

import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { RunContext } from '../../src/run/execute/types.js'
import {
  runExecutorAgentGrantPrepareTool,
  runExecutorLifecyclePrepareTool,
  runExecutorWorkspacePromotionPrepareTool,
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
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    protocolVersion: 1, revision: 1, profiles: ['workspace_sandbox'], operationKeys: ['file.read'],
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    supervisor: 'service', sandboxBackend: 'none', localPolicyDigest: `sha256:${'1'.repeat(64)}`,
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
  })
  await prisma.executorCapabilityRevision.create({ data: {
    executorId: executor.id, revision: 1, descriptor, signature: 'test',
    localPolicyDigest: descriptor.localPolicyDigest, reviewStatus: 'active', reviewedByUserId: owner.id,
  } })
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
  assert.match(result.outputPreview, /Posted an Allow access card in this chat/)
  assert.match(result.outputPreview, /No additional code is required/)
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
      messageId: true,
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
  assert.equal(spec.title, 'Allow CTO on Minis')
  assert.deepEqual(spec.actions, [{ key: 'allow_access', label: 'Allow access', style: 'primary', submits: true }])
  assert.match(JSON.stringify(spec.blocks), /No additional verification code/)
  assert.match(JSON.stringify(spec.blocks), /file.read/)
  // Server-written copy: nothing in the card or its message is a way in.
  for (const text of [JSON.stringify(card.spec), card.message.content, JSON.stringify(card.message.metadata)]) {
    assert.doesNotMatch(text, /confirmationToken|accessChange=/)
  }
  assert.equal(card.message.role, 'assistant')
  const alert = await prisma.userAlert.findFirstOrThrow({ where: { userId: s.ownerId, messageId: card.messageId } })
  assert.equal(alert.threadId, s.threadId)
  assert.equal(alert.channelId, s.home.id)
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

// The workspace promotion prepare tool answered with `#confirmationToken=` in
// its output too — the same secret in the same model-visible text. It posts
// the same card now, holding only the promotion's id.
runDatabaseTest('a prepared workspace promotion posts the same card, and no token', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  const queueJobIds: string[] = []
  t.after(async () => {
    // The receipt rows restrict their executor's deletion; they go first.
    await prisma.executorCommand.deleteMany({ where: { binding: { executorId: s.executorId } } })
    await prisma.executorBinding.deleteMany({ where: { executorId: s.executorId } })
    await prisma.queueJob.deleteMany({ where: { id: { in: queueJobIds } } })
    await cleanup(prisma, s)
    await prisma.$disconnect()
  })
  const secret = `promotion-card-${randomUUID()}`

  // A reviewed draft the owner's own run produced: the command the promotion
  // names, with its encrypted receipt.
  const revision = await prisma.executorCapabilityRevision.create({
    data: {
      descriptor: {},
      executorId: s.executorId,
      localPolicyDigest: 'test',
      reviewStatus: 'active',
      revision: 1,
      signature: 'test',
    },
  })
  const trigger = await prisma.message.create({
    data: { content: 'Promote the draft', role: 'user', threadId: s.threadId, userId: s.ownerId },
  })
  const reviewRun = await prisma.run.create({
    data: { agentId: s.targetAgentId, status: 'completed', threadId: s.threadId, triggerMessageId: trigger.id },
  })
  const binding = await prisma.executorBinding.create({
    data: {
      authorizationRevision: 0,
      candidateHandleDigest: 'test',
      capabilityRevisionId: revision.id,
      executorId: s.executorId,
      fence: 1n,
      operationKey: 'workspace.review',
      runId: reviewRun.id,
    },
  })
  const queueJob = await prisma.queueJob.create({
    data: { payload: {}, status: 'completed', topic: 'executor.command' },
  })
  queueJobIds.push(queueJob.id)
  const toolCall = await prisma.toolCall.create({
    data: {
      agentId: s.targetAgentId,
      inputSummary: 'Review the draft',
      runId: reviewRun.id,
      startedAt: new Date(),
      toolName: 'executor.workspace.review',
    },
  })
  const manifestDigest = `sha256:${'a'.repeat(64)}`
  const command = await prisma.executorCommand.create({
    data: {
      argumentDigest: 'test',
      bindingId: binding.id,
      queueJobId: queueJob.id,
      resultCiphertext: JSON.stringify(encryptWithKeyRing(
        toEncryptionKeyRing(secret),
        AT_REST_SECRET_PURPOSE.executorCommand,
        JSON.stringify({
          changeCount: 1,
          changes: [{ byteCount: 12, kind: 'created', path: 'draft.txt' }],
          manifestDigest,
          success: true,
        }),
      )),
      resultDigest: `sha256:${'b'.repeat(64)}`,
      state: 'result_acknowledged',
      toolCallId: toolCall.id,
    },
  })

  const context = designerContext(prisma, s)
  const result = await runExecutorWorkspacePromotionPrepareTool(
    { ...context, executorCommandEncryptionSecret: secret } as BuiltinToolRuntimeContext,
    { reviewCommandId: command.id },
  )

  assert.match(result.outputPreview, /Posted an Allow access card in this chat/)
  assert.doesNotMatch(result.outputPreview, /confirmationToken|#|\/agents\/executors/)
  assert.doesNotMatch(result.outputPreview.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/, ''), TOKEN_SHAPE)
  assert.equal(result.deliveredToConversation, true)

  const promotion = await prisma.executorContinuation.findFirstOrThrow({
    where: { executorId: s.executorId, subject: 'invocation' },
    select: { expiresAt: true, id: true },
  })
  const card = await prisma.agentCard.findFirstOrThrow({
    where: { threadId: s.threadId },
    select: {
      executorAccessChangeId: true,
      executorWorkspacePromotionId: true,
      expiresAt: true,
      message: { select: { content: true, metadata: true } },
      respondentUserIds: true,
      spec: true,
    },
  })
  assert.equal(card.executorWorkspacePromotionId, promotion.id)
  assert.equal(card.executorAccessChangeId, null)
  assert.deepEqual(card.respondentUserIds, [s.ownerId])
  assert.equal(card.expiresAt?.getTime(), promotion.expiresAt.getTime())
  const spec = AgentCardSpecSchema.parse(card.spec)
  assert.equal(spec.title, 'Confirm a workspace promotion')
  assert.equal(spec.subtitle, 'Write 1 reviewed change to the host workspace')
  assert.deepEqual(spec.actions, [{ key: 'review', label: 'Review', style: 'primary', submits: true }])
  for (const text of [JSON.stringify(card.spec), card.message.content, JSON.stringify(card.message.metadata)]) {
    assert.doesNotMatch(text, /confirmationToken|promotion=/)
  }
})
