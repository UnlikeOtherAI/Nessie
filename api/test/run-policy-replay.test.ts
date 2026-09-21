import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import { Prisma, PrismaClient } from '@prisma/client'
import { AuthorizedActionContextSchema, type RunExecuteJobPayload } from '@nessie/schemas'
import { captureChannelPolicyAuthorizer } from '@nessie/team-admin'
import { registerRunRoutes } from '../src/routes/runs.js'
import { continueRun } from '../src/services/run-continuation.js'
import { restartRun } from '../src/services/runs.js'

const dbTest = process.env.DATABASE_URL ? test : test.skip
const PROMPT = 'Record the agreed decision in the channel documentation.'

const fixture = async (prisma: PrismaClient) => {
  const org = await prisma.organization.create({ data: { name: `policy-replay-${randomUUID()}` } })
  const users = await Promise.all(['authorizer', 'clicker'].map((name) => prisma.user.create({
    data: { email: `${name}-${randomUUID()}@example.test`, displayName: name },
  })))
  const [authorizer, clicker] = users
  await prisma.organizationMember.createMany({
    data: users.map((user) => ({ userId: user.id, organizationId: org.id, role: 'member' })),
  })
  const project = await prisma.project.create({ data: { name: 'Project', organizationId: org.id } })
  const team = await prisma.team.create({ data: { name: 'Team', projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: 'decisions', slug: `decisions-${randomUUID()}`, organizationId: org.id,
      projectId: project.id, teamId: team.id, visibility: 'public',
    },
  })
  await prisma.channelMember.createMany({ data: users.map((user) => ({ channelId: channel.id, userId: user.id })) })
  const agent = await prisma.agent.create({ data: { name: 'Recorder', organizationId: org.id, visibility: 'team' } })
  await prisma.agentBinding.create({ data: { agentId: agent.id, channelId: channel.id } })
  const contextFor = (userId: string) => AuthorizedActionContextSchema.parse({
    actor: { actorType: 'user', actorId: userId, roles: ['member'] },
    tenant: { organizationId: org.id }, actionContext: { requestId: randomUUID() },
  })
  const savedAuthorizer = captureChannelPolicyAuthorizer(contextFor(authorizer!.id), {
    userId: authorizer!.id, channelId: channel.id, organizationId: org.id,
  })
  const thread = await prisma.thread.create({ data: { channelId: channel.id } })
  const snapshot = {
    policyFingerprint: 'pinned-policy', authorizer: savedAuthorizer, basisScopes: [], disclosureSources: [],
    decisions: [{ action: 'reply', agentId: agent.id, policyWork: true, promptOverride: PROMPT }],
  }
  const message = await prisma.message.create({
    data: {
      role: 'user', userId: clicker!.id, threadId: thread.id, content: 'Jo, berem tu druhou možnost.',
      channelDecision: snapshot as Prisma.InputJsonValue,
    },
  })
  const run = await prisma.run.create({
    data: { agentId: agent.id, threadId: thread.id, triggerMessageId: message.id, status: 'failed', promptOverride: PROMPT },
  })
  await prisma.runCheckpoint.create({
    data: {
      runId: run.id, agentId: agent.id, threadId: thread.id, organizationId: org.id,
      generation: 1, note: 'The decision was confirmed.', reason: 'token_limit',
    },
  })
  const cleanup = async () => {
    await prisma.$executeRaw`DELETE FROM queue_jobs WHERE payload->>'threadId' = ${thread.id}`
    await prisma.taskEvent.deleteMany({ where: { task: { organizationId: org.id } } })
    await prisma.task.deleteMany({ where: { organizationId: org.id } })
    await prisma.run.deleteMany({ where: { threadId: thread.id } })
    await prisma.message.deleteMany({ where: { threadId: thread.id } })
    await prisma.thread.delete({ where: { id: thread.id } })
    await prisma.agentBinding.deleteMany({ where: { channelId: channel.id } })
    await prisma.channelMember.deleteMany({ where: { channelId: channel.id } })
    await prisma.channel.delete({ where: { id: channel.id } })
    await prisma.agent.delete({ where: { id: agent.id } })
    await prisma.team.delete({ where: { id: team.id } })
    await prisma.project.delete({ where: { id: project.id } })
    await prisma.organizationMember.deleteMany({ where: { organizationId: org.id } })
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } })
    await prisma.organization.delete({ where: { id: org.id } })
  }
  return {
    agent, authorizer: authorizer!, channel, cleanup, clicker: contextFor(clicker!.id),
    message, org, run, snapshot, thread,
  }
}

for (const operation of ['restart', 'continue'] as const) {
  const invoke = operation === 'restart' ? restartRun : continueRun
  dbTest(`channel policy replay: ${operation} pins authorizer, prompt and background authority`, async (t) => {
    const prisma = new PrismaClient()
    const f = await fixture(prisma)
    t.after(async () => { await f.cleanup(); await prisma.$disconnect() })
    // Current configuration is deliberately gone: the immutable trigger owns replay.
    await prisma.channel.update({ where: { id: f.channel.id }, data: { decisionPolicy: Prisma.JsonNull } })
    const result = await invoke(prisma, f.clicker, { organizationId: f.org.id, runId: f.run.id })
    assert.ok(result.kind === 'restarted' || result.kind === 'continued', JSON.stringify(result))
    if (result.kind !== 'restarted' && result.kind !== 'continued') return
    const jobs = await prisma.$queryRaw<{ payload: RunExecuteJobPayload }[]>`
      SELECT payload FROM queue_jobs WHERE idempotency_key = ${`run:${operation}:${result.runId}`}
    `
    const payload = jobs[0]!.payload
    assert.equal(payload.actorContext.actor.actorId, f.authorizer.id)
    assert.notEqual(payload.actorContext.actor.actorId, f.clicker.actor.actorId)
    assert.equal(payload.actorContext.actionContext.effectiveUserId, f.authorizer.id)
    assert.equal(payload.actorContext.actionContext.purpose, 'channel.policy')
    assert.equal(payload.interactive, false)
    assert.equal(payload.promptOverride, PROMPT)
    assert.equal((await prisma.run.findUniqueOrThrow({ where: { id: result.runId } })).promptOverride, PROMPT)
  })

  dbTest(`channel policy replay: ${operation} refuses revoked authorizer with HTTP 403 and no claim`, async (t) => {
    const prisma = new PrismaClient()
    const f = await fixture(prisma)
    const app = Fastify()
    t.after(async () => { await app.close(); await f.cleanup(); await prisma.$disconnect() })
    await prisma.organizationMember.update({
      where: { organizationId_userId: { organizationId: f.org.id, userId: f.authorizer.id } },
      data: { deactivatedAt: new Date() },
    })
    registerRunRoutes(app, {
      prisma, requireActorContext: () => f.clicker,
    } as unknown as Parameters<typeof registerRunRoutes>[1])
    const response = await app.inject({ method: 'POST', url: `/api/runs/${f.run.id}/${operation}` })
    assert.equal(response.statusCode, 403)
    assert.match(response.body, /RUN_POLICY_AUTHORITY_UNAVAILABLE/)
    assert.equal(await prisma.run.count({ where: { threadId: f.thread.id } }), 1)
    assert.equal((await prisma.runCheckpoint.findUniqueOrThrow({ where: { runId: f.run.id } })).consumedByRunId, null)
  })
}

dbTest('channel policy replay: a missing exact binding or changed work cannot become ordinary caller work', async (t) => {
  const prisma = new PrismaClient()
  const f = await fixture(prisma)
  t.after(async () => { await f.cleanup(); await prisma.$disconnect() })
  await prisma.agentBinding.deleteMany({ where: { channelId: f.channel.id } })
  assert.deepEqual(await restartRun(prisma, f.clicker, { organizationId: f.org.id, runId: f.run.id }), {
    kind: 'policy_authority_unavailable',
  })
  await prisma.agentBinding.create({ data: { agentId: f.agent.id, channelId: f.channel.id } })
  await prisma.run.update({ where: { id: f.run.id }, data: { promptOverride: 'Different instructions' } })
  assert.deepEqual(await continueRun(prisma, f.clicker, { organizationId: f.org.id, runId: f.run.id }), {
    kind: 'policy_authority_unavailable',
  })
})

dbTest('channel policy replay: an ordinary reply beside custom work retains the clicker’s authority', async (t) => {
  const prisma = new PrismaClient()
  const f = await fixture(prisma)
  t.after(async () => { await f.cleanup(); await prisma.$disconnect() })
  const ordinaryPrompt = 'Answer the conversation briefly.'
  await prisma.message.update({
    where: { id: f.message.id },
    data: { channelDecision: {
      ...f.snapshot,
      decisions: [...f.snapshot.decisions, { action: 'reply', agentId: f.agent.id, promptOverride: ordinaryPrompt }],
    } as Prisma.InputJsonValue },
  })
  await prisma.run.update({ where: { id: f.run.id }, data: { promptOverride: ordinaryPrompt } })
  const result = await restartRun(prisma, f.clicker, { organizationId: f.org.id, runId: f.run.id })
  assert.equal(result.kind, 'restarted')
  if (result.kind !== 'restarted') return
  const jobs = await prisma.$queryRaw<{ payload: RunExecuteJobPayload }[]>`
    SELECT payload FROM queue_jobs WHERE idempotency_key = ${`run:restart:${result.runId}`}
  `
  assert.equal(jobs[0]!.payload.actorContext.actor.actorId, f.clicker.actor.actorId)
  assert.equal(jobs[0]!.payload.actorContext.actionContext.purpose, undefined)
  assert.equal(jobs[0]!.payload.interactive, true)
  assert.equal(jobs[0]!.payload.promptOverride, ordinaryPrompt)
})

dbTest('channel policy replay: Continue refuses checkpoint sources the authorizer can no longer read', async (t) => {
  const prisma = new PrismaClient()
  const f = await fixture(prisma)
  const source = await prisma.channel.create({
    data: {
      label: 'Restricted source', slug: `source-${randomUUID()}`, organizationId: f.org.id,
      projectId: f.channel.projectId, teamId: f.channel.teamId, visibility: 'protected',
    },
  })
  t.after(async () => {
    await prisma.channelMember.deleteMany({ where: { channelId: source.id } })
    await prisma.channel.delete({ where: { id: source.id } })
    await f.cleanup()
    await prisma.$disconnect()
  })
  await prisma.channelMember.create({ data: { channelId: source.id, userId: f.clicker.actor.actorId } })
  await prisma.runBasisScope.create({ data: { runId: f.run.id, scopeType: 'channel', scopeId: source.id } })
  assert.deepEqual(await continueRun(prisma, f.clicker, { organizationId: f.org.id, runId: f.run.id }), {
    kind: 'policy_authority_unavailable',
  })
  assert.equal((await prisma.runCheckpoint.findUniqueOrThrow({ where: { runId: f.run.id } })).consumedByRunId, null)
})
