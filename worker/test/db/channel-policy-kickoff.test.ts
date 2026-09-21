import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import type { PgRealtimeTransport } from '@nessie/runtime'
import {
  AuthorizedActionContextSchema, OrchestrateDecideJobPayloadSchema, RunExecuteJobPayloadSchema,
} from '@nessie/schemas'
import { captureChannelPolicyAuthorizer } from '@nessie/team-admin'
import { dispatchOrchestratorDecisions } from '../../src/run/orchestrate-dispatch.js'
import { drainPendingThreadMessages } from '../../src/run/thread-serialization.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { admitTriggerMessageLineage } from '../../src/run/execute/private-conversation-lineage.js'
import { resolveReplyRootMessageId } from '../../src/run/execute/reply-placement.js'
import { deleteThreadQueueJobs, runDatabaseTest } from './support.js'

runDatabaseTest('a reply and policy kickoff preserve separate human authority through pending and replay', async (t) => {
  const prisma = new PrismaClient()
  const organizationId = randomUUID()
  const authorizerId = randomUUID()
  const posterId = randomUUID()
  const agentId = randomUUID()
  const threadId = randomUUID()
  t.after(async () => {
    await deleteThreadQueueJobs(prisma, threadId)
    await prisma.runThreadPendingMessage.deleteMany({ where: { threadId } })
    await prisma.task.deleteMany({ where: { organizationId } })
    await prisma.message.deleteMany({ where: { threadId } })
    await prisma.run.deleteMany({ where: { threadId } })
    await prisma.agent.deleteMany({ where: { id: agentId } })
    await prisma.organization.deleteMany({ where: { id: organizationId } })
    await prisma.user.deleteMany({ where: { id: { in: [authorizerId, posterId] } } })
    await prisma.$disconnect()
  })
  await prisma.organization.create({ data: { id: organizationId, name: 'Policy kickoff test' } })
  await prisma.user.createMany({ data: [authorizerId, posterId].map((id) => ({
    id, displayName: 'Policy colleague', email: `policy-kickoff-${id}@example.test`,
  })) })
  await prisma.organizationMember.createMany({ data: [
    { organizationId, userId: authorizerId, role: 'owner' },
    { organizationId, userId: posterId, role: 'member' },
  ] })
  const project = await prisma.project.create({ data: { organizationId, name: 'Project' } })
  const team = await prisma.team.create({ data: { projectId: project.id, name: 'Team' } })
  const channel = await prisma.channel.create({ data: {
    organizationId, projectId: project.id, teamId: team.id,
    label: 'Decisions', slug: 'decisions', visibility: 'protected',
    members: { create: [{ userId: authorizerId }, { userId: posterId }] },
  } })
  await prisma.thread.create({ data: { id: threadId, channelId: channel.id } })
  await prisma.agent.create({ data: { id: agentId, organizationId, teamId: team.id, name: 'Recorder' } })
  await prisma.agentBinding.create({ data: { agentId, channelId: channel.id } })
  const actorFor = (userId: string) => AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId, roles: [userId === authorizerId ? 'owner' : 'member'] },
    tenant: { organizationId, projectId: project.id, teamId: team.id },
    actionContext: { requestId: randomUUID(), effectiveUserId: userId },
  })
  const authorizer = captureChannelPolicyAuthorizer(actorFor(authorizerId), {
    channelId: channel.id, organizationId, userId: authorizerId,
  })
  const replyPrompt = 'Odpověz kolegovi stručně na jeho dotaz.'
  const workPrompt = 'Zapiš potvrzené rozhodnutí do projektové dokumentace.'
  const reply = { action: 'reply' as const, agentId, replyPlacement: 'thread' as const, promptOverride: replyPrompt }
  const work = {
    action: 'reply' as const, agentId, replyPlacement: 'thread' as const,
    promptOverride: workPrompt, background: true, policyWork: true,
  }
  const snapshot = {
    policyFingerprint: 'kickoff-regression', authorizer, decisions: [reply, work],
    basisScopes: [{ scopeType: 'channel', scopeId: channel.id }],
    disclosureSources: [
      { sourceAuthorUserId: authorizerId, sourceChannelId: channel.id },
      { sourceAuthorUserId: null, sourceChannelId: channel.id },
    ],
  }
  const source = await prisma.message.create({ data: {
    threadId, role: 'user', userId: posterId, content: 'jj berem béčko, mrkneš pls na další krok?',
    channelDecision: snapshot as Prisma.InputJsonValue,
  } })
  const payload = OrchestrateDecideJobPayloadSchema.parse({
    actorContext: actorFor(posterId), channelId: channel.id, threadId,
    messageId: source.id, content: source.content, role: 'user',
    channelAgents: [{ id: agentId, name: 'Recorder', role: 'assistant', systemPrompt: null }],
  })
  const publications: unknown[] = []
  const realtimeTransport = {
    publishWs: async (...args: unknown[]) => { publications.push(args) },
    publishSse: async (...args: unknown[]) => { publications.push(args) },
  } as unknown as PgRealtimeTransport
  const dispatch = () => dispatchOrchestratorDecisions(
    { prisma, realtimeTransport }, payload, channel, [reply, work], authorizer,
  )
  const queued = async () => {
    const rows = await prisma.$queryRaw<{ payload: unknown }[]>`
      SELECT payload FROM queue_jobs WHERE topic = 'run.execute' AND payload->>'threadId' = ${threadId}
    `
    return rows.map((row) => RunExecuteJobPayloadSchema.parse(row.payload))
  }

  await dispatch()
  const runs = await prisma.run.findMany({ where: { threadId } })
  assert.equal(runs.length, 1)
  const normalRun = runs[0]!
  assert.equal(normalRun.triggerMessageId, source.id)
  assert.equal(normalRun.promptOverride, replyPrompt)
  const initialJobs = await queued()
  assert.equal(initialJobs.length, 1)
  assert.equal(initialJobs[0]?.actorContext.actor.actorId, posterId)
  assert.equal(initialJobs[0]?.actorContext.actionContext.effectiveUserId, posterId)
  assert.notEqual(initialJobs[0]?.actorContext.actionContext.purpose, 'channel.policy')
  assert.equal(initialJobs[0]?.interactive, true)
  assert.equal(initialJobs[0]?.promptOverride, replyPrompt)

  const pending = await prisma.runThreadPendingMessage.findFirstOrThrow({ where: { threadId } })
  const pendingActor = AuthorizedActionContextSchema.parse(pending.actorContext)
  assert.equal(pendingActor.actor.actorId, authorizerId)
  assert.equal(pendingActor.actionContext.effectiveUserId, authorizerId)
  assert.equal(pendingActor.actionContext.purpose, 'channel.policy')
  assert.equal(pending.interactive, false)
  assert.equal(pending.promptOverride, workPrompt)
  assert.equal(pending.replyPlacement, 'thread')
  const kickoff = await prisma.message.findUniqueOrThrow({
    where: { id: pending.messageId },
    include: { basisScopes: true, disclosureSources: true, thread: { include: { channel: true } } },
  })
  assert.notEqual(kickoff.id, source.id)
  assert.equal(kickoff.role, 'system')
  assert.equal(kickoff.content, workPrompt)
  assert.equal(kickoff.rootMessageId, source.id)
  assert.equal(kickoff.threadId, threadId)
  assert.deepEqual(kickoff.metadata, { channelPolicyKickoff: { sourceMessageId: source.id } })
  assert.deepEqual(kickoff.basisScopes.map(({ scopeType, scopeId }) => ({ scopeType, scopeId })),
    [{ scopeType: 'channel', scopeId: channel.id }])
  assert.deepEqual(new Set(kickoff.disclosureSources.map((entry) => entry.sourceAuthorUserId)),
    new Set([authorizerId, posterId, null]), 'canonical readers retain the same authors as run admission')
  const sink = createConsumedSourceSink()
  await admitTriggerMessageLineage(prisma, sink, kickoff)
  assert.deepEqual(new Set(sink.privateConversationSources().map((entry) => entry.sourceAuthorUserId)),
    new Set([authorizerId, posterId, null]))
  assert.deepEqual(sink.list(), [{ scopeType: 'channel', scopeId: channel.id }])
  assert.equal(publications.length, 1, 'only the ordinary reply publishes a visible start')
  assert.ok(JSON.stringify(publications).includes(source.id))
  assert.ok(!JSON.stringify(publications).includes(kickoff.id))
  assert.ok(!JSON.stringify(publications).includes(workPrompt))

  await prisma.run.update({ where: { id: normalRun.id }, data: { status: 'completed', finishedAt: new Date() } })
  const followUpId = await drainPendingThreadMessages(prisma, { agentId, threadId })
  assert.ok(followUpId)
  const followUp = await prisma.run.findUniqueOrThrow({ where: { id: followUpId } })
  assert.equal(followUp.triggerMessageId, kickoff.id)
  assert.equal(followUp.promptOverride, workPrompt)
  assert.equal(followUp.threadId, threadId)
  assert.equal(followUp.replyPlacement, 'thread')
  assert.equal(resolveReplyRootMessageId(kickoff, null, followUp.replyPlacement), source.id)
  const jobs = await queued()
  assert.equal(jobs.length, 2)
  const workJob = jobs.find((job) => job.runId === followUpId)
  assert.ok(workJob)
  assert.equal(workJob.actorContext.actor.actorId, authorizerId)
  assert.equal(workJob.actorContext.actionContext.effectiveUserId, authorizerId)
  assert.equal(workJob.actorContext.actionContext.purpose, 'channel.policy')
  assert.equal(workJob.interactive, false)
  assert.equal(workJob.promptOverride, workPrompt)
  assert.equal(workJob.messageId, kickoff.id)

  await dispatch()
  assert.equal(await prisma.run.count({ where: { threadId } }), 2)
  assert.equal(await prisma.runThreadPendingMessage.count({ where: { threadId } }), 0)
  assert.equal(await prisma.message.count({ where: { threadId } }), 2)
  assert.equal(await prisma.messageBasisScope.count({ where: { messageId: kickoff.id } }), 1)
  assert.equal(await prisma.messageDisclosureSource.count({ where: { messageId: kickoff.id } }), 3)
  assert.equal((await queued()).length, 2)
  assert.equal(publications.length, 1, 'replay neither announces nor exposes the hidden kickoff')
})
