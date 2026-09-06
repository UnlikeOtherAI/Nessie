import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema } from '@nessie/schemas'
import type { AuthorizedActionContext } from '@nessie/schemas'

import {
  AGENT_DESIGNER_BLUEPRINT,
  ensureGlobalAgentBootstrap,
} from '@nessie/team-admin'
import { enqueueOrchestrateDecide } from '@nessie/db'
import { resumeSuspendedRun } from '../src/services/run-resume-core.js'
import {
  resolveDelegatedRequesterUserId,
  resolveIdentityDelegatedToolIds,
} from '@nessie/worker'

/**
 * A run started in a single-member delegated system DM carries
 * `effectiveUserId = that member` — asserted end to end, from the enqueue the
 * wake path performs to the tool set the worker's gate then admits.
 *
 * This is the invariant the agent-card press broke. Nothing failed when it did:
 * `resolveDelegatedRequesterUserId` simply returned null, every
 * identity-delegated tool vanished from the model's function set, and the Agent
 * Designer truthfully reported that it could not create anything. A green unit
 * test over the gate could not have caught it, because the gate was correct —
 * the actor context reaching it was not. So the assertions below run the real
 * enqueue and the real resume against Postgres and then feed their persisted
 * payloads to the real gate.
 *
 * Seed-scoped throughout: this database is shared with suites running
 * concurrently, so no global delete and no global count appears here.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

type Seed = {
  designerAgentId: string
  designerChannelId: string
  designerThreadId: string
  ordinaryChannelId: string
  ordinaryThreadId: string
  organizationId: string
  paChannelId: string
  paThreadId: string
  prisma: PrismaClient
  projectId: string
  teamId: string
  userId: string
}

const actorContextFor = (context: Seed): AuthorizedActionContext =>
  AuthorizedActionContextSchema.parse({
    actor: { actorId: context.userId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId: context.organizationId, teamId: context.teamId },
    actionContext: { requestId: randomUUID() },
  })

const seed = async (label: string): Promise<Seed> => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const userId = randomUUID()

  await prisma.organization.create({
    data: { id: organizationId, name: `${label}-${organizationId}` },
  })
  await prisma.user.create({
    data: { displayName: 'Card presser', email: `${userId}@test.local`, id: userId },
  })
  await prisma.organizationMember.create({
    data: { organizationId, role: 'owner', userId },
  })
  const project = await prisma.project.create({
    data: { name: `${label} project`, organizationId },
  })
  const team = await prisma.team.create({ data: { name: `${label} team`, projectId: project.id } })

  // The real bootstrap: the Agent Designer's row plus its `gagent:` home DM,
  // its sole membership and its default thread.
  const home = await ensureGlobalAgentBootstrap(prisma, {
    blueprint: AGENT_DESIGNER_BLUEPRINT,
    organizationId,
    teamId: team.id,
    userId,
  })

  const paChannel = await prisma.channel.create({
    data: {
      dmKey: `pa:${organizationId}:${userId}`,
      label: 'Personal Assistant',
      organizationId,
      projectId: project.id,
      systemChannelType: 'personal_assistant',
      teamId: team.id,
      threads: { create: { title: 'Personal Assistant' } },
      type: 'dm',
      visibility: 'private',
    },
    select: { id: true, threads: { select: { id: true } } },
  })
  const ordinaryChannel = await prisma.channel.create({
    data: {
      label: `${label}-room`,
      organizationId,
      projectId: project.id,
      slug: `${label}-room`,
      teamId: team.id,
      threads: { create: { title: 'General' } },
    },
    select: { id: true, threads: { select: { id: true } } },
  })

  return {
    designerAgentId: home.agentId,
    designerChannelId: home.channelId,
    designerThreadId: home.threadId,
    ordinaryChannelId: ordinaryChannel.id,
    ordinaryThreadId: ordinaryChannel.threads[0]!.id,
    organizationId,
    paChannelId: paChannel.id,
    paThreadId: paChannel.threads[0]!.id,
    prisma,
    projectId: project.id,
    teamId: team.id,
    userId,
  }
}

const teardown = async (context: Seed): Promise<void> => {
  // Scoped to this seed's own rows. `queue_jobs` has no tenant column, so the
  // jobs are matched on the organisation inside their own payload — never a
  // `LIKE` over a shared key prefix, which would delete another suite's work.
  await context.prisma.$executeRaw`
    DELETE FROM queue_jobs
     WHERE payload->'actorContext'->'tenant'->>'organizationId' = ${context.organizationId}
  `
  await context.prisma.organization.deleteMany({ where: { id: context.organizationId } })
  await context.prisma.user.deleteMany({ where: { id: context.userId } })
  await context.prisma.$disconnect()
}

/** The enqueued job's actor context, read back out of the queue row. */
const enqueuedActorContext = async (
  prisma: PrismaClient,
  idempotencyKey: string,
): Promise<AuthorizedActionContext> => {
  const rows = await prisma.$queryRaw<{ payload: { actorContext: unknown } }[]>`
    SELECT payload FROM queue_jobs WHERE idempotency_key = ${idempotencyKey}
  `
  assert.equal(rows.length, 1, `expected exactly one queued job for ${idempotencyKey}`)
  return AuthorizedActionContextSchema.parse(rows[0]!.payload.actorContext)
}

const orchestratePayload = (context: Seed, channelId: string, threadId: string) => ({
  actorContext: actorContextFor(context),
  channelAgents: [{
    id: context.designerAgentId,
    name: 'Agent Designer',
    role: 'designer',
    systemPrompt: null,
  }],
  channelId,
  content: 'Build it',
  messageId: randomUUID(),
  role: 'user' as const,
  threadId,
})

dbTest('a card press in a global agent home DM enqueues a delegated identity', async () => {
  const context = await seed('delegated-dm-identity')
  const { prisma } = context
  try {
    // The exact shape `POST /api/agent-cards/:id/respond` enqueues after a
    // press: a `user` turn in the Designer's home DM, waking its own agent.
    const key = `orchestrate:card:${randomUUID()}`
    await enqueueOrchestrateDecide(
      prisma,
      orchestratePayload(context, context.designerChannelId, context.designerThreadId),
      key,
    )

    const actorContext = await enqueuedActorContext(prisma, key)
    assert.equal(actorContext.actionContext.effectiveUserId, context.userId)

    // …and the worker's gate therefore admits the blueprint's tools. This is
    // the assertion the bug would fail: with no stamp the requester resolves to
    // null and the set is empty, which is exactly what the Designer reported.
    const channel = await prisma.channel.findUniqueOrThrow({
      select: { dmKey: true, organizationId: true, systemChannelType: true },
      where: { id: context.designerChannelId },
    })
    const requesterUserId = resolveDelegatedRequesterUserId({
      actorId: actorContext.actor.actorId,
      actorType: actorContext.actor.actorType,
      effectiveUserId: actorContext.actionContext.effectiveUserId,
      // The card route enqueues an ordinary human turn, which the orchestrator
      // marks interactive because the actor is a person.
      interactive: actorContext.actor.actorType === 'user',
    })
    assert.equal(requesterUserId, context.userId)

    const admitted = resolveIdentityDelegatedToolIds(
      {
        agentKind: 'shared',
        dmKey: channel.dmKey,
        organizationId: channel.organizationId,
        systemChannelType: channel.systemChannelType,
        systemSlug: AGENT_DESIGNER_BLUEPRINT.slug,
      },
      requesterUserId,
    )
    for (const toolId of AGENT_DESIGNER_BLUEPRINT.identityToolIds) {
      assert.ok(admitted.has(toolId), `expected ${toolId} to be admitted`)
    }
    assert.ok(admitted.has('agent_create'))
    assert.ok(admitted.has('channel_create'))
    assert.ok(admitted.has('agent_bind_channel'))
    assert.ok(admitted.has('agent_trigger_create'))
  } finally {
    await teardown(context)
  }
})

dbTest('the personal assistant DM keeps its existing stamp', async () => {
  const context = await seed('delegated-dm-identity-pa')
  const { prisma } = context
  try {
    const key = `orchestrate:pa:${randomUUID()}`
    await enqueueOrchestrateDecide(
      prisma,
      orchestratePayload(context, context.paChannelId, context.paThreadId),
      key,
    )
    const actorContext = await enqueuedActorContext(prisma, key)
    assert.equal(actorContext.actionContext.effectiveUserId, context.userId)
  } finally {
    await teardown(context)
  }
})

dbTest('an ordinary channel stamps nothing', async () => {
  const context = await seed('delegated-dm-identity-room')
  const { prisma } = context
  try {
    const key = `orchestrate:room:${randomUUID()}`
    await enqueueOrchestrateDecide(
      prisma,
      orchestratePayload(context, context.ordinaryChannelId, context.ordinaryThreadId),
      key,
    )
    const actorContext = await enqueuedActorContext(prisma, key)
    assert.equal(actorContext.actionContext.effectiveUserId, undefined)

    // No delegation outside a single-member system DM, whatever the agent is.
    assert.equal(
      resolveDelegatedRequesterUserId({
        actorId: actorContext.actor.actorId,
        actorType: actorContext.actor.actorType,
        effectiveUserId: actorContext.actionContext.effectiveUserId,
        interactive: true,
      }),
      null,
    )
  } finally {
    await teardown(context)
  }
})

dbTest('a resumed wait:true card run recovers the delegated identity', async () => {
  const context = await seed('delegated-dm-identity-resume')
  const { prisma } = context
  try {
    // A card posted with `wait: true` parks its run in `waiting_input` with a
    // checkpoint. The resume state carries the parked run's enqueue-time actor
    // context — deliberately unstamped here, which is precisely the state a
    // pre-fix card press left behind.
    const triggerMessage = await prisma.message.create({
      data: { content: 'Build it', role: 'user', threadId: context.designerThreadId },
      select: { id: true },
    })
    const parked = await prisma.run.create({
      data: {
        agentId: context.designerAgentId,
        status: 'waiting_input',
        threadId: context.designerThreadId,
        triggerMessageId: triggerMessage.id,
      },
      select: { id: true },
    })
    await prisma.runCheckpoint.create({
      data: {
        agentId: context.designerAgentId,
        note: 'waiting on the card',
        organizationId: context.organizationId,
        reason: 'card_wait',
        runId: parked.id,
        threadId: context.designerThreadId,
      },
    })

    const unstamped = actorContextFor(context)
    assert.equal(unstamped.actionContext.effectiveUserId, undefined)

    const resumed = await prisma.$transaction((tx) =>
      resumeSuspendedRun(tx, {
        eventPayload: { fromCardId: randomUUID() },
        interactive: true,
        organizationId: context.organizationId,
        queueKeyPrefix: 'run:card',
        resumeActorContext: unstamped,
        runId: parked.id,
        suspendedStatus: 'waiting_input',
        triggerMessageId: triggerMessage.id,
      }))

    const actorContext = await enqueuedActorContext(prisma, `run:card:${resumed.runId}`)
    assert.equal(actorContext.actionContext.effectiveUserId, context.userId)
    assert.equal(
      resolveDelegatedRequesterUserId({
        actorId: actorContext.actor.actorId,
        actorType: actorContext.actor.actorType,
        effectiveUserId: actorContext.actionContext.effectiveUserId,
        interactive: true,
      }),
      context.userId,
    )
  } finally {
    await teardown(context)
  }
})
