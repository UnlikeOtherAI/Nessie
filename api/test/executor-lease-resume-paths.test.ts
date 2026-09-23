import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  carryForwardExecutorBindings,
  ensureExecutorLogicalTools,
  resolveExecutorAvailabilityCandidates,
} from '@nessie/executor-manage'
import {
  AuthorizedActionContextSchema,
  ExecutorCapabilityDescriptorSchema,
  PERSON_MESSAGE_AUTHORSHIP,
  RunExecuteJobPayloadSchema,
  type AuthorizedActionContext,
  type ImplementedExecutorOperationKey,
} from '@nessie/schemas'

import { createRequestHelpers } from '../src/lib/request-helpers.js'
import { respondToAgentCard } from '../src/services/agent-card-response.js'
import { loadReadableCard } from '../src/services/agent-cards.js'
import { resumeRunFromApproval } from '../src/services/approval-resume.js'
import { launchExecutorRun } from '../src/services/executor-run-launch.js'
import { createThreadMessage } from '../src/services/message-create.js'
import { continueRun } from '../src/services/run-continuation.js'
import { restartRun } from '../src/services/runs.js'

/**
 * Every way a person brings a stopped run back — Continue, Restart, an
 * approval, a card answer — driven through its real service against a real
 * database, then handed to the conversation-lease carry exactly as the worker
 * receives it: the job the service enqueued. The carry's own suite builds jobs
 * by hand, which shows the helper refuses the shape it expects; this shows
 * each producer produces that shape (docs/plans/2026-09-22-executor-local-apps/
 * conversation-lease.md §2, condition 6).
 *
 * The approval and card resumes act as the parked run's own actor — the
 * holder, whose turn parked — whoever pressed. So the only thing that can
 * refuse another member's press there is who pressed, which is what these pin.
 *
 * Every row is this seed's own; nothing global is counted or deleted.
 */
const dbTest = process.env.DATABASE_URL ? test : test.skip

const LOCAL_APPS: ImplementedExecutorOperationKey[] = ['mcp.tools', 'mcp.call']

type World = {
  agentId: string
  cleanup: () => Promise<void>
  contextFor: (userId: string) => AuthorizedActionContext
  deps: Parameters<typeof respondToAgentCard>[0]
  executorId: string
  holderId: string
  launchMessageId: string
  leaseId: string
  memberId: string
  organizationId: string
  prisma: PrismaClient
  threadId: string
}

const seed = async (prisma: PrismaClient): Promise<World> => {
  const organizationId = randomUUID()
  const [holderId, memberId] = [randomUUID(), randomUUID()]
  const agentId = randomUUID()
  const executorId = randomUUID()
  await prisma.organization.create({ data: { id: organizationId, name: `lease resume ${organizationId}` } })
  await prisma.user.createMany({
    data: [holderId, memberId].map((id) => ({ id, email: `${id}@example.test`, displayName: id.slice(0, 8) })),
  })
  await prisma.organizationMember.createMany({
    data: [holderId, memberId].map((userId) => ({ organizationId, userId, role: 'member' as const })),
  })
  const project = await prisma.project.create({ data: { name: 'p', organizationId } })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'launch-room', slug: `c-${randomUUID()}`, organizationId, projectId: project.id, teamId: team.id,
      visibility: 'public',
    },
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const tools = await ensureExecutorLogicalTools(prisma, organizationId)
  await prisma.agent.create({
    data: { id: agentId, name: 'CTO', organizationId, toolPolicy: Object.fromEntries(LOCAL_APPS.map((key) => [tools.get(key)!, true])) },
  })
  await prisma.agentBinding.create({ data: { agentId, channelId: channel.id } })
  await prisma.executor.create({
    data: {
      id: executorId, organizationId, pairingOwnerUserId: holderId, label: 'Minis', scopeKind: 'organization',
      status: 'online', lastSeenAt: new Date(), profiles: ['workspace_sandbox'],
    },
  })
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    protocolVersion: 1, revision: 1, profiles: ['workspace_sandbox'], operationKeys: LOCAL_APPS,
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    supervisor: 'service', sandboxBackend: 'none', localPolicyDigest: `sha256:${'6'.repeat(64)}`,
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
  })
  await prisma.executorCapabilityRevision.create({
    data: {
      executorId, revision: 1, descriptor, signature: 'reviewed', localPolicyDigest: descriptor.localPolicyDigest,
      reviewStatus: 'active', reviewedByUserId: holderId,
    },
  })
  await prisma.executorAgentOperationGrant.createMany({
    data: LOCAL_APPS.map((operationKey) => ({
      agentId, authorizationRevision: 1, executorId, operationKey, state: 'allowed' as const, updatedByUserId: holderId,
    })),
  })
  const contextFor = (userId: string) => AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId, roles: ['member'] }, tenant: { organizationId },
    actionContext: { requestId: randomUUID() },
  })

  // The holder launches local apps in the room; the launch run finishes.
  const availability = await resolveExecutorAvailabilityCandidates(prisma, contextFor(holderId), {
    agentId, operationKeys: LOCAL_APPS,
  })
  const candidate = availability.candidates[0]
  assert.ok(candidate, JSON.stringify(availability.explanations))
  const launched = await launchExecutorRun(prisma, contextFor(holderId), {
    agentId, candidateHandle: candidate.handle, content: 'Open the staging site', operationKeys: LOCAL_APPS,
    threadId: thread.id,
  })
  assert.equal(launched.kind, 'launched')
  if (launched.kind !== 'launched') throw new Error('launch failed')
  await prisma.run.update({ where: { id: launched.runId }, data: { status: 'completed' } })
  const lease = await prisma.executorConversationLease.findFirstOrThrow({ where: { launchRunId: launched.runId } })

  const cleanup = async () => {
    await prisma.$executeRaw`DELETE FROM queue_jobs WHERE payload->>'threadId' = ${thread.id}`
    await prisma.$executeRaw`
      DELETE FROM queue_jobs WHERE payload->'actorContext'->'tenant'->>'organizationId' = ${organizationId}
    `
    await prisma.agentCard.deleteMany({ where: { organizationId } })
    await prisma.approvalRequest.deleteMany({ where: { organizationId } })
    await prisma.taskEvent.deleteMany({ where: { task: { organizationId } } })
    await prisma.task.deleteMany({ where: { organizationId } })
    await prisma.run.deleteMany({ where: { threadId: thread.id } })
    await prisma.executorConversationLease.deleteMany({ where: { organizationId } })
    await prisma.executorAvailabilityCandidate.deleteMany({ where: { executorId } })
    await prisma.executor.deleteMany({ where: { id: executorId } })
    await prisma.message.deleteMany({ where: { threadId: thread.id } })
    await prisma.thread.deleteMany({ where: { id: thread.id } })
    await prisma.channel.deleteMany({ where: { id: channel.id } })
    await prisma.agent.deleteMany({ where: { id: agentId } })
    await prisma.team.deleteMany({ where: { id: team.id } })
    await prisma.project.deleteMany({ where: { id: project.id } })
    await prisma.organizationMember.deleteMany({ where: { organizationId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [holderId, memberId] } } })
  }
  return {
    agentId, cleanup, contextFor,
    deps: {
      ...createRequestHelpers(prisma),
      dashboardCredentials: {},
      mcpSecretStore: {},
      messageMemoryCaptureConfig: null,
      prisma,
      realtimeHub: { publishWs: async () => undefined },
    } as unknown as World['deps'],
    executorId, holderId, launchMessageId: launched.message.id, leaseId: lease.id, memberId, organizationId,
    prisma, threadId: thread.id,
  }
}

const withWorld = async (run: (world: World) => Promise<void>): Promise<void> => {
  const prisma = new PrismaClient()
  const world = await seed(prisma)
  try {
    await run(world)
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

/** The holder's own reply in the launch's reply thread — a turn that carries. */
const holderReply = async (world: World) => {
  const created = await createThreadMessage(world.prisma, {
    authorship: PERSON_MESSAGE_AUTHORSHIP, content: 'Now check the pricing page',
    rootMessageId: world.launchMessageId, threadId: world.threadId, userId: world.holderId,
  })
  assert.equal(created.kind, 'created')
  if (created.kind !== 'created') throw new Error('reply failed')
  return created.message
}

/** A run the holder's reply started, stopped in `status` with its checkpoint. */
const stoppedRun = async (
  world: World,
  status: 'failed' | 'waiting_approval' | 'waiting_input',
  triggerMessageId: string,
) => {
  const run = await world.prisma.run.create({
    data: { agentId: world.agentId, status, threadId: world.threadId, triggerMessageId },
  })
  await world.prisma.runCheckpoint.create({
    data: {
      agentId: world.agentId, note: 'Working notes.', organizationId: world.organizationId,
      reason: status === 'failed' ? 'token_limit' : status, runId: run.id, threadId: world.threadId,
    },
  })
  return run
}

/** Hand the job the service really enqueued to the carry, as run setup does. */
const carryEnqueued = async (world: World, queueKey: string, runId: string) => {
  const [job] = await world.prisma.$queryRaw<{ payload: unknown }[]>`
    SELECT payload FROM queue_jobs WHERE idempotency_key = ${queueKey}
  `
  assert.ok(job, `the service enqueued ${queueKey}`)
  const outcome = await carryForwardExecutorBindings(world.prisma, {
    job: RunExecuteJobPayloadSchema.parse(job.payload), runId,
  })
  const bindings = await world.prisma.executorBinding.count({ where: { runId } })
  // The successor is done; free the (agent, thread) slot for the next press.
  await world.prisma.run.update({ where: { id: runId }, data: { status: 'completed' } })
  return { bindings, outcome }
}

const refusedForAnotherPress = (world: World) => ({
  bindings: 0, outcome: { kind: 'refused', leaseId: world.leaseId, reason: 'actor_not_holder' },
})

dbTest('Continue or Restart pressed by another member carries nothing; the holder’s own Continue does', async () => {
  await withWorld(async (world) => {
    const reply = await holderReply(world)

    const pressedByMember = await stoppedRun(world, 'failed', reply.id)
    const continued = await continueRun(world.prisma, world.contextFor(world.memberId), {
      organizationId: world.organizationId, runId: pressedByMember.id,
    })
    assert.equal(continued.kind, 'continued')
    if (continued.kind !== 'continued') return
    assert.deepEqual(
      await carryEnqueued(world, `run:continue:${continued.runId}`, continued.runId),
      refusedForAnotherPress(world),
    )

    const restartedByMember = await stoppedRun(world, 'failed', reply.id)
    const restarted = await restartRun(world.prisma, world.contextFor(world.memberId), {
      organizationId: world.organizationId, runId: restartedByMember.id,
    })
    assert.equal(restarted.kind, 'restarted')
    if (restarted.kind !== 'restarted') return
    assert.deepEqual(
      await carryEnqueued(world, `run:restart:${restarted.runId}`, restarted.runId),
      refusedForAnotherPress(world),
    )

    const pressedByHolder = await stoppedRun(world, 'failed', reply.id)
    const own = await continueRun(world.prisma, world.contextFor(world.holderId), {
      organizationId: world.organizationId, runId: pressedByHolder.id,
    })
    assert.equal(own.kind, 'continued')
    if (own.kind !== 'continued') return
    const carried = await carryEnqueued(world, `run:continue:${own.runId}`, own.runId)
    assert.equal(carried.outcome.kind, 'carried')
    assert.equal(carried.bindings, 2)
  })
})

dbTest('an approval another member granted resumes the holder’s run without the holder’s machine', async () => {
  await withWorld(async (world) => {
    const reply = await holderReply(world)
    const approve = async (resolverId: string) => {
      const parked = await stoppedRun(world, 'waiting_approval', reply.id)
      const approval = await world.prisma.approvalRequest.create({
        data: {
          action: 'tool.invoke', agentId: world.agentId, argsHash: 'args-hash',
          context: { inputSummary: '{}', toolName: 'message_send' }, continuationToken: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000), organizationId: world.organizationId,
          reason: 'Tool message_send requires approval.', requesterId: world.agentId,
          // What resolving writes. `requiredApproverUserId` is null for a tool
          // that is not structurally gated, so any member may approve it.
          resolverId, resolvedAt: new Date(), status: 'approved',
          // The parked run's own enqueue-time actor: the holder.
          resumeState: {
            actorContext: world.contextFor(world.holderId), args: {}, interactive: true, messageId: reply.id,
          },
          runId: parked.id, toolCallId: `tool-call-${randomUUID()}`, toolName: 'message_send',
        },
      })
      const resumed = await resumeRunFromApproval(world.prisma, approval.id)
      assert.equal(resumed.kind, 'resumed')
      if (resumed.kind !== 'resumed') throw new Error('not resumed')
      return carryEnqueued(world, `run:approval:${resumed.runId}`, resumed.runId)
    }

    assert.deepEqual(await approve(world.memberId), refusedForAnotherPress(world))
    const own = await approve(world.holderId)
    assert.equal(own.outcome.kind, 'carried', 'the holder approving their own gated call keeps their machine')
    assert.equal(own.bindings, 2)
  })
})

dbTest('a card another member answered resumes the holder’s run without the holder’s machine', async () => {
  await withWorld(async (world) => {
    const reply = await holderReply(world)
    const answer = async (respondentId: string) => {
      const parked = await stoppedRun(world, 'waiting_input', reply.id)
      const cardMessage = await world.prisma.message.create({
        data: {
          agentId: world.agentId, content: 'Which environment?', role: 'assistant',
          rootMessageId: world.launchMessageId, threadId: world.threadId,
        },
      })
      const thread = await world.prisma.thread.findUniqueOrThrow({ where: { id: world.threadId } })
      const card = await world.prisma.agentCard.create({
        data: {
          agentId: world.agentId, channelId: thread.channelId, messageId: cardMessage.id,
          organizationId: world.organizationId,
          // Empty: anyone in the thread may answer.
          respondentUserIds: [],
          resumeState: { actorContext: world.contextFor(world.holderId), interactive: true, messageId: reply.id },
          runId: parked.id,
          spec: {
            schemaVersion: 1, title: 'Which environment?',
            blocks: [{ type: 'text', markdown: 'Pick one.' }],
            actions: [{ key: 'staging', label: 'Staging', style: 'primary', submits: true }],
          },
          status: 'open', threadId: world.threadId, waitRunId: parked.id,
        },
      })
      const loaded = await loadReadableCard(world.prisma, {
        cardId: card.id, organizationId: world.organizationId, userId: respondentId,
      })
      assert.ok(loaded, 'the respondent can read the card')
      await respondToAgentCard(world.deps, {
        actionKey: 'staging', actorContext: world.contextFor(respondentId), card: loaded,
      })
      const { resumedByRunId } = await world.prisma.agentCard.findUniqueOrThrow({ where: { id: card.id } })
      assert.ok(resumedByRunId, 'the answer resumed the parked run')
      return carryEnqueued(world, `run:card:${resumedByRunId}`, resumedByRunId)
    }

    assert.deepEqual(await answer(world.memberId), refusedForAnotherPress(world))
    const own = await answer(world.holderId)
    assert.equal(own.outcome.kind, 'carried', 'the holder answering their own card keeps their machine')
    assert.equal(own.bindings, 2)

    // The refusal is on the record against the member who answered.
    const refusals = await world.prisma.auditLog.findMany({
      where: { action: 'executor.run.carry_refused', organizationId: world.organizationId },
    })
    assert.equal(refusals.length, 1)
    assert.equal(refusals[0]!.actorId, world.holderId, 'the run acted as the holder…')
    assert.equal((refusals[0]!.metadata as Record<string, unknown>).resumedByUserId, world.memberId,
      '…and the row says whose press it was')
    assert.equal(refusals[0]!.reason, 'actor_not_holder')
  })
})
