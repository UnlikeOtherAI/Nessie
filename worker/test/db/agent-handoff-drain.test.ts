import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  AuthorizedActionContextSchema,
  GLOBAL_AGENT_BRIEF_PURPOSE,
  withDelegatedSystemDmIdentity,
} from '@nessie/schemas'
import {
  AGENT_DESIGNER_BLUEPRINT,
  AGENT_DESIGNER_SLUG,
  ensureGlobalAgentBootstrap,
} from '@nessie/team-admin'

import { runAgentHandoffTool } from '../../src/run/pa-tools/agent-handoff.js'
import { resolveReplyRootMessageId } from '../../src/run/execute/reply-placement.js'
import { claimThreadRunOrPend, drainPendingThreadMessages } from '../../src/run/thread-serialization.js'
import { buildContext, cleanup, seed } from './agent-handoff-fixture.js'
import { runDatabaseTest } from './support.js'

// A handoff brief is a hidden `system` kickoff. In an ordinary batch only the
// latest pending row drives the run and `system` rows never reach the model as
// history, so a brief pended behind a busy home DM and followed by the
// person's next message would be silently dropped. The brief carries its own
// purpose, and that purpose drains alone.

type QueuedRunPayload = {
  actorContext: {
    actor: { actorId: string; actorType: string }
    actionContext: { effectiveUserId?: string; purpose?: string }
  }
  batchMessageIds?: string[]
  interactive?: boolean
  messageId: string
}

const queuedPayload = async (prisma: PrismaClient, idempotencyKey: string): Promise<QueuedRunPayload> =>
  (await prisma.queueJob.findFirstOrThrow({ where: { idempotencyKey } })).payload as QueuedRunPayload

runDatabaseTest('a brief on a free home DM starts its run under the brief purpose', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(async () => {
    await cleanup(prisma, team)
    await prisma.$disconnect()
  })

  await runAgentHandoffTool(buildContext(prisma, team), {
    brief: 'They want an agent that files expense receipts every Friday.',
    target: AGENT_DESIGNER_SLUG,
  })
  // The direct path and the drained path carry one purpose, so a restart that
  // replays the payload sees the same run either way.
  const payload = await queuedPayload(prisma, `handoff:${team.runId}:${AGENT_DESIGNER_SLUG}`)
  assert.equal(payload.actorContext.actionContext.purpose, GLOBAL_AGENT_BRIEF_PURPOSE)
  assert.equal(payload.actorContext.actor.actorId, team.ownerId)
  assert.equal(payload.actorContext.actionContext.effectiveUserId, team.ownerId)
})

runDatabaseTest('a brief pended behind a busy home DM drains alone, before the person\'s next message', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(async () => {
    await cleanup(prisma, team)
    await prisma.$disconnect()
  })

  const home = await ensureGlobalAgentBootstrap(prisma, {
    blueprint: AGENT_DESIGNER_BLUEPRINT,
    organizationId: team.organizationId,
    userId: team.ownerId,
  })
  const busy = await prisma.run.create({
    data: { agentId: home.agentId, status: 'waiting_input', threadId: home.threadId },
  })

  await runAgentHandoffTool(buildContext(prisma, team), {
    brief: 'They want an agent that files expense receipts every Friday.',
    target: AGENT_DESIGNER_SLUG,
  })
  const brief = await prisma.message.findFirstOrThrow({
    where: { role: 'system', threadId: home.threadId },
    select: { id: true },
  })

  // The person follows the doorway and types before the open card settles.
  // The orchestrator's reply claim pends that turn behind the brief.
  const typed = await prisma.message.create({
    data: {
      content: 'also it should skip receipts under five euros',
      // `messages.created_at` is `timestamp(3)`: state the arrival order.
      createdAt: new Date(Date.now() + 1_000),
      role: 'user',
      threadId: home.threadId,
      userId: team.ownerId,
    },
    select: { id: true },
  })
  const typedContext = withDelegatedSystemDmIdentity(AuthorizedActionContextSchema.parse({
    actor: { actorId: team.ownerId, actorType: 'user', roles: ['owner'] },
    tenant: { organizationId: team.organizationId, projectId: team.projectId, teamId: team.teamId },
    actionContext: { requestId: randomUUID() },
  }), { systemChannelType: 'system_agent' })
  assert.equal(await prisma.$transaction((tx) => claimThreadRunOrPend(tx, {
    agentId: home.agentId,
    threadId: home.threadId,
    pending: { actorContext: typedContext, channelId: home.channelId, interactive: true, messageId: typed.id },
  })), 'pended')

  const expected = [
    { messageId: brief.id, purpose: GLOBAL_AGENT_BRIEF_PURPOSE, replyRoot: undefined },
    { messageId: typed.id, purpose: undefined, replyRoot: typed.id },
  ]
  let predecessorId = busy.id
  for (const turn of expected) {
    await prisma.run.update({
      where: { id: predecessorId },
      data: { finishedAt: new Date(), status: 'completed' },
    })
    const runId = await drainPendingThreadMessages(prisma, {
      agentId: home.agentId,
      threadId: home.threadId,
    })
    assert.ok(runId, 'each terminal drain starts exactly one follow-up')

    const run = await prisma.run.findUniqueOrThrow({
      where: { id: runId },
      select: { replyPlacement: true, triggerMessageId: true },
    })
    assert.equal(run.triggerMessageId, turn.messageId)
    const trigger = await prisma.message.findUniqueOrThrow({
      where: { id: turn.messageId },
      select: { id: true, rootMessageId: true },
    })
    // The brief is invisible, so its answer lands in the DM itself.
    assert.equal(resolveReplyRootMessageId(trigger, null, run.replyPlacement), turn.replyRoot)

    const payload = await queuedPayload(prisma, `run:batch:${runId}`)
    assert.equal(payload.messageId, turn.messageId)
    assert.deepEqual(payload.batchMessageIds, [turn.messageId], 'nothing else is folded into this run')
    assert.equal(payload.interactive, true)
    assert.equal(payload.actorContext.actor.actorId, team.ownerId)
    assert.equal(payload.actorContext.actionContext.effectiveUserId, team.ownerId)
    assert.equal(payload.actorContext.actionContext.purpose, turn.purpose)
    predecessorId = runId
  }
  assert.equal(
    await prisma.runThreadPendingMessage.count({
      where: { agentId: home.agentId, threadId: home.threadId },
    }),
    0,
  )
})
