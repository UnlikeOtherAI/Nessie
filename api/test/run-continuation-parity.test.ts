import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import {
  parseOrganizationId,
  parseProjectId,
  parseTeamId,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { resumeRunFromApproval } from '../src/services/approval-resume.js'
import { continueRun } from '../src/services/run-continuation.js'

/**
 * The Continue press and the approval resume are the same act.
 *
 * They were two implementations of it — six duplicated steps that had already
 * drifted apart on the actor-context wrapping order — and are now one
 * (`resumeSuspendedRun`). This test is what holds them together: for the same
 * stopped run in the same shape, both must produce the same continuation run,
 * the same task, the same `run.continued` event and the same enqueued job.
 * A future divergence has to break this before it can reach a person.
 */

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  agentId: string
  channelId: string
  organizationId: string
  projectId: string
  teamId: string
  userId: string
}

const actorFor = (seed: Seed): AuthorizedActionContext => ({
  actor: { actorId: seed.userId, actorType: 'user', roles: ['owner'] },
  actionContext: { requestId: `parity-${randomUUID()}` },
  tenant: {
    organizationId: parseOrganizationId(seed.organizationId),
    projectId: parseProjectId(seed.projectId),
    teamId: parseTeamId(seed.teamId),
  },
})

const PROMPT = 'compare the two continuation paths'

const seedTeam = async (prisma: PrismaClient): Promise<Seed> => {
  const organization = await prisma.organization.create({
    data: { name: `parity ${randomUUID()}` },
  })
  const project = await prisma.project.create({
    data: { name: 'project', organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: 'team', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'parity',
      organizationId: organization.id,
      projectId: project.id,
      slug: `parity-${randomUUID()}`,
      teamId: team.id,
      visibility: 'public',
    },
  })
  const agent = await prisma.agent.create({
    data: { name: 'Parity agent', organizationId: organization.id },
  })
  const user = await prisma.user.create({
    data: { displayName: 'Presser', email: `parity-${randomUUID()}@example.com` },
  })
  return {
    agentId: agent.id,
    channelId: channel.id,
    organizationId: organization.id,
    projectId: project.id,
    teamId: team.id,
    userId: user.id,
  }
}

const cleanup = async (prisma: PrismaClient, seed: Seed): Promise<void> => {
  const threads = await prisma.thread.findMany({
    where: { channelId: seed.channelId },
    select: { id: true },
  })
  for (const thread of threads) {
    await prisma
      .$executeRaw`DELETE FROM queue_jobs WHERE payload->>'threadId' = ${thread.id}`
      .catch(() => undefined)
  }
  await prisma.approvalRequest.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.taskEvent.deleteMany({ where: { task: { organizationId: seed.organizationId } } })
  await prisma.task.deleteMany({ where: { organizationId: seed.organizationId } })
  await prisma.message.deleteMany({ where: { thread: { channelId: seed.channelId } } })
  await prisma.run.deleteMany({ where: { thread: { channelId: seed.channelId } } })
  await prisma.thread.deleteMany({ where: { channelId: seed.channelId } })
  await prisma.channel.deleteMany({ where: { id: seed.channelId } })
  await prisma.agent.deleteMany({ where: { id: seed.agentId } })
  await prisma.team.deleteMany({ where: { id: seed.teamId } })
  await prisma.project.deleteMany({ where: { id: seed.projectId } })
  await prisma.user.deleteMany({ where: { id: seed.userId } })
  await prisma.organization.deleteMany({ where: { id: seed.organizationId } })
}

/** One stopped run with an unconsumed checkpoint, in a thread of its own. */
const seedStoppedRun = async (
  prisma: PrismaClient,
  seed: Seed,
  status: 'failed' | 'waiting_approval',
) => {
  const thread = await prisma.thread.create({ data: { channelId: seed.channelId } })
  const message = await prisma.message.create({
    data: { content: PROMPT, role: 'user', threadId: thread.id, userId: seed.userId },
  })
  const run = await prisma.run.create({
    data: {
      agentId: seed.agentId,
      // A PA shared-channel presence, deliberately: `effectiveUserId =
      // principalUserId` is the stamp the two paths used to disagree about —
      // the Continue press made it, the resume core did not — so an
      // unreconciled pair fails on `actionContextKeys` alone.
      principalUserId: seed.userId,
      status,
      threadId: thread.id,
      triggerMessageId: message.id,
    },
  })
  const task = await prisma.task.create({
    data: {
      agentId: seed.agentId,
      organizationId: seed.organizationId,
      purpose: PROMPT,
      runId: run.id,
      status: 'inbox',
    },
  })
  const checkpoint = await prisma.runCheckpoint.create({
    data: {
      agentId: seed.agentId,
      generation: 1,
      note: 'Working notes from the stopped run.',
      organizationId: seed.organizationId,
      reason: status === 'failed' ? 'token_limit' : 'approval_required',
      runId: run.id,
      threadId: thread.id,
    },
  })
  return { checkpoint, message, run, task, threadId: thread.id }
}

type ContinuationShape = {
  effectiveUserId: unknown
  event: unknown
  job: unknown
  run: unknown
  task: unknown
}

/**
 * Everything about a continuation that is not an identifier or a clock read.
 * Ids differ between the two paths by construction; the shape must not.
 */
const readContinuationShape = async (
  prisma: PrismaClient,
  input: { queueKey: string; runId: string; taskId: string },
): Promise<ContinuationShape> => {
  const run = await prisma.run.findUniqueOrThrow({ where: { id: input.runId } })
  const task = await prisma.task.findUniqueOrThrow({ where: { id: input.taskId } })
  const events = await prisma.taskEvent.findMany({
    where: { eventType: 'run.continued', taskId: input.taskId },
  })
  assert.equal(events.length, 1)
  const jobs = await prisma.$queryRaw<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM queue_jobs WHERE idempotency_key = ${input.queueKey}
  `
  assert.equal(jobs.length, 1)
  const payload = jobs[0]!.payload
  const actorContext = payload['actorContext'] as {
    actionContext: Record<string, unknown>
    actor: Record<string, unknown>
  }
  const eventPayload = events[0]!.payload as Record<string, unknown>
  return {
    effectiveUserId: actorContext.actionContext['effectiveUserId'],
    event: { auto: eventPayload['auto'] },
    job: {
      // Which fields the job carries, and the values that are not ids.
      actionContextKeys: Object.keys(actorContext.actionContext).sort(),
      actorType: actorContext.actor['actorType'],
      interactive: payload['interactive'],
      payloadKeys: Object.keys(payload).sort(),
    },
    run: {
      continuationOf: run.continuationOfRunId === null ? null : 'set',
      principalUserId: run.principalUserId,
      replyPlacement: run.replyPlacement,
      status: run.status,
    },
    task: { purpose: task.purpose, status: task.status },
  }
}

runDatabaseTest(
  'a Continue press and an approval resume produce the same continuation shape',
  async (t) => {
    const prisma = new PrismaClient()
    const seed = await seedTeam(prisma)
    t.after(async () => {
      await cleanup(prisma, seed)
      await prisma.$disconnect()
    })

    const pressed = await seedStoppedRun(prisma, seed, 'failed')
    const parked = await seedStoppedRun(prisma, seed, 'waiting_approval')
    const approval = await prisma.approvalRequest.create({
      data: {
        action: 'tool.invoke',
        agentId: seed.agentId,
        argsHash: 'args-hash',
        channelId: seed.channelId,
        context: { inputSummary: '{}', toolName: 'message_send' },
        continuationToken: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
        organizationId: seed.organizationId,
        projectId: seed.projectId,
        reason: 'Tool message_send requires approval.',
        requesterId: seed.agentId,
        resumeState: {
          actorContext: actorFor(seed),
          args: {},
          interactive: true,
          messageId: parked.message.id,
        },
        runId: parked.run.id,
        status: 'approved',
        taskId: parked.task.id,
        teamId: seed.teamId,
        toolCallId: 'tool-call-1',
        toolName: 'message_send',
      },
    })

    const continued = await continueRun(prisma, actorFor(seed), {
      organizationId: seed.organizationId,
      runId: pressed.run.id,
    })
    assert.equal(continued.kind, 'continued')
    if (continued.kind !== 'continued') return

    const resumed = await resumeRunFromApproval(prisma, approval.id)
    assert.equal(resumed.kind, 'resumed')
    if (resumed.kind !== 'resumed') return

    const pressedShape = await readContinuationShape(prisma, {
      queueKey: `run:continue:${continued.runId}`,
      runId: continued.runId,
      taskId: continued.taskId,
    })
    const resumedShape = await readContinuationShape(prisma, {
      queueKey: `run:approval:${resumed.runId}`,
      runId: resumed.runId,
      taskId: resumed.taskId,
    })
    assert.deepEqual(pressedShape, resumedShape)
    // …and the shape they agree on is the right one: a PA presence's
    // continuation acts as its principal, or every identity-delegated tool
    // silently vanishes from the model's function set.
    assert.equal(pressedShape.effectiveUserId, seed.userId)

    // Both claim their own checkpoint set-once, and neither touches the other's.
    for (const [checkpointId, runId] of [
      [pressed.checkpoint.id, continued.runId],
      [parked.checkpoint.id, resumed.runId],
    ] as const) {
      const checkpoint = await prisma.runCheckpoint.findUnique({ where: { id: checkpointId } })
      assert.equal(checkpoint?.consumedByRunId, runId)
    }
  },
)
