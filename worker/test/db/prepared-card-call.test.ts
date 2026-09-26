import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { AgentCardSpecSchema, type AgentCardSpec } from '@nessie/schemas'
import { createAgentRecord } from '@nessie/team-admin'

import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { claimPreparedCardCall, recordPreparedCardOutcome } from '../../src/run/execute/prepared-card-call.js'
import type { RunContext } from '../../src/run/execute/types.js'
import { loadMessageCardNotes } from '../../src/run/message-cards.js'
import { claimCardWithTypedAnswer, loadAnswerableCard } from '../../src/run/orchestrate-card-answer.js'
import { postAgentCard } from '../../src/run/pa-tools/agent-card-post.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

/**
 * Prepared card buttons against real rows (docs/standards/agent-cards.md →
 * "A prepared button runs its call"): the calls stored beside the spec and
 * never in it, the answer's run claiming the call once through Postgres's own
 * JSON null, a typed answer claiming the card the way a press does, and the
 * note a later run reads.
 */

type Seed = {
  agentId: string
  homeId: string
  organizationId: string
  ownerId: string
  projectId: string
  runId: string
  teamId: string
  threadId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const owner = await prisma.user.create({
    data: { displayName: 'Owner', email: `prepared-card-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `prepared-card-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: owner.id },
  })
  const project = await prisma.project.create({ data: { name: `project-${suffix}`, organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const agent = await createAgentRecord(prisma, {
    name: 'Booker',
    organizationId: organization.id,
    ownerUserId: owner.id,
    role: 'assistant',
    teamId: team.id,
    visibility: 'private',
  })
  assert.ok(agent.homeChannelId)
  const home = await prisma.channel.findUniqueOrThrow({
    where: { id: agent.homeChannelId },
    select: { id: true, threads: { select: { id: true } } },
  })
  const threadId = home.threads[0]!.id
  const run = await prisma.run.create({ data: { agentId: agent.id, status: 'running', threadId } })
  return {
    agentId: agent.id, homeId: home.id, organizationId: organization.id, ownerId: owner.id,
    projectId: project.id, runId: run.id, teamId: team.id, threadId,
  }
}

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: s.organizationId } })
  await prisma.user.deleteMany({ where: { id: s.ownerId } })
}

const context = (prisma: PrismaClient, s: Seed): BuiltinToolRuntimeContext => {
  const consumedSources = createConsumedSourceSink()
  const runContext: RunContext = {
    agent: {
      agentKind: 'shared', effort: 'medium', executionMode: 'inference', id: s.agentId, model: null,
      name: 'Booker', ownerUserId: s.ownerId, parentAgentId: null, provider: null, systemPrompt: null,
      visibility: 'private',
    },
    boundAgentIds: [],
    channel: {
      dmKey: `agent:${s.organizationId}:${s.ownerId}:${s.agentId}`, id: s.homeId,
      organizationId: s.organizationId, projectId: s.projectId, systemChannelType: null,
      teamId: s.teamId, visibility: 'private',
    },
    consumedSources,
    run: { createdAt: new Date(), id: s.runId, replyPlacement: null, threadId: s.threadId },
    task: { id: randomUUID() },
  }
  return {
    actorContext: {
      actionContext: { requestId: randomUUID() },
      actor: { actorId: s.ownerId, actorType: 'user', roles: ['owner'] },
      tenant: { organizationId: s.organizationId, teamId: s.teamId },
    },
    agentId: s.agentId,
    agentKind: 'shared',
    channel: { id: s.homeId, organizationId: s.organizationId, systemChannelType: null },
    consumedSources,
    ledgerIdentity: null,
    prisma,
    realtimeTransport: { publishSse: async () => undefined, publishWs: async () => undefined },
    run: {
      id: s.runId, interactive: true, messageId: randomUUID(), originatingUserId: s.ownerId, threadId: s.threadId,
    },
    runContext,
    toolCallId: randomUUID(),
  } as unknown as BuiltinToolRuntimeContext
}

const spec: AgentCardSpec = AgentCardSpecSchema.parse({
  schemaVersion: 1,
  title: 'Book the Aquarium room',
  blocks: [{ type: 'text', markdown: 'Which slot?' }],
  actions: [
    { key: 'thursday', label: 'Thu 10:00', style: 'primary', submits: false },
    { key: 'friday', label: 'Fri 14:00', style: 'secondary', submits: false },
  ],
})
const preparedActions = {
  friday: { arguments: { day: 'friday', room: 'Aquarium', time: '14:00' }, tool: 'room_book' },
}

const postCard = (prisma: PrismaClient, s: Seed) => {
  const tool = context(prisma, s)
  return postAgentCard(tool, (tool as unknown as { runContext: RunContext }).runContext, {
    card: spec, expiresAt: null, preparedActions, respondentUserIds: [s.ownerId],
  })
}

const personSays = (prisma: PrismaClient, s: Seed, content: string, rootMessageId: string | null = null) =>
  prisma.message.create({
    data: { content, role: 'user', rootMessageId, threadId: s.threadId, userId: s.ownerId },
    select: { createdAt: true, id: true, rootMessageId: true, userId: true },
  })

runDatabaseTest('a pressed prepared button’s call is claimed once and its outcome noted', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => cleanup(prisma, s).then(() => prisma.$disconnect()))

  const posted = await postCard(prisma, s)
  const stored = await prisma.agentCard.findUniqueOrThrow({ where: { id: posted.cardId } })
  assert.deepEqual(stored.preparedActions, preparedActions)
  assert.equal(JSON.stringify(stored.spec).includes('room_book'), false, 'the spec viewers receive never holds the call')
  assert.equal(stored.preparedExecution, null)

  // The press, as the API writes it: the person's reply under the card, then the claim.
  const press = await personSays(prisma, s, 'Fri 14:00', posted.messageId)
  await prisma.agentCard.update({
    data: { resolvedActionKey: 'friday', resolvedAt: new Date(), resolvedByUserId: s.ownerId,
      responseMessageId: press.id, status: 'resolved' },
    where: { id: posted.cardId },
  })

  const answerRun = await prisma.run.create({ data: { agentId: s.agentId, status: 'running', threadId: s.threadId } })
  const otherRun = await prisma.run.create({ data: { agentId: s.agentId, status: 'running', threadId: s.threadId } })
  const claimFor = (runId: string) =>
    claimPreparedCardCall(prisma, { messageId: press.id }, { agent: { id: s.agentId }, run: { id: runId } })

  const claimed = await claimFor(answerRun.id)
  assert.equal(claimed?.call.toolName, 'room_book')
  assert.deepEqual(claimed?.call.arguments, preparedActions.friday.arguments)
  assert.equal(await claimFor(otherRun.id), null, 'Postgres keeps the claim to one run')
  assert.ok(await claimFor(answerRun.id), 'the claiming run may pick it up again after a crash')

  const [before] = [...(await loadMessageCardNotes(prisma, s.organizationId, [posted.messageId])).values()]
  assert.match(before!, /Fri 14:00 \(runs room_book\)/)
  assert.match(before!, /room_book started as prepared/)

  await recordPreparedCardOutcome(prisma, claimed!, { preparedCompleted: true, runId: answerRun.id })
  assert.equal(await claimFor(answerRun.id), null, 'a finished call never runs again')
  const [after] = [...(await loadMessageCardNotes(prisma, s.organizationId, [posted.messageId])).values()]
  assert.match(after!, /room_book ran as prepared and succeeded/)
})

runDatabaseTest('a typed answer right under the card claims it as a press would', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => cleanup(prisma, s).then(() => prisma.$disconnect()))

  const posted = await postCard(prisma, s)
  const words = await personSays(prisma, s, 'pátek se hodí')
  const card = await loadAnswerableCard(prisma, {
    agentId: s.agentId, threadId: s.threadId, trigger: { ...words, userId: s.ownerId },
  })
  assert.ok(card, 'the card right above the words is answerable')
  assert.deepEqual(card.offer.options.map((option) => option.key), ['friday'])

  const published: unknown[] = []
  const realtimeTransport = { publishWs: async (_scopes: unknown, event: unknown) => { published.push(event) } }
  const claim = () => claimCardWithTypedAnswer({ prisma, realtimeTransport: realtimeTransport as never }, {
    actionKey: 'friday', card, channelId: s.homeId, messageId: words.id, userId: s.ownerId,
  })
  assert.equal(await claim(), true)
  assert.equal(await claim(), false, 'one answer per card')
  assert.equal(published.length, 1)

  const resolved = await prisma.agentCard.findUniqueOrThrow({ where: { id: posted.cardId } })
  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.responseMessageId, words.id)
  assert.equal(resolved.resolvedActionKey, 'friday')

  // The answer's run then finds the call exactly as it would after a press.
  const run = await prisma.run.create({ data: { agentId: s.agentId, status: 'running', threadId: s.threadId } })
  const prepared = await claimPreparedCardCall(prisma, { messageId: words.id }, {
    agent: { id: s.agentId }, run: { id: run.id },
  })
  assert.equal(prepared?.call.toolName, 'room_book')

  // Once anything else has been said below the card, words no longer answer it.
  await postCard(prisma, s)
  await personSays(prisma, s, 'hmm')
  const later = await personSays(prisma, s, 'pátek')
  assert.equal(await loadAnswerableCard(prisma, {
    agentId: s.agentId, threadId: s.threadId, trigger: { ...later, userId: s.ownerId },
  }), null)
})

runDatabaseTest('an approved continuation takes over the suspended run\u2019s claim, through Postgres JSON equality', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => cleanup(prisma, s).then(() => prisma.$disconnect()))

  const posted = await postCard(prisma, s)
  const press = await personSays(prisma, s, 'Fri 14:00', posted.messageId)
  await prisma.agentCard.update({
    data: { resolvedActionKey: 'friday', resolvedAt: new Date(), resolvedByUserId: s.ownerId,
      responseMessageId: press.id, status: 'resolved' },
    where: { id: posted.cardId },
  })
  const suspended = await prisma.run.create({ data: { agentId: s.agentId, status: 'running', threadId: s.threadId } })
  const claimFor = (runId: string) =>
    claimPreparedCardCall(prisma, { messageId: press.id }, { agent: { id: s.agentId }, run: { id: runId } })

  const claimed = await claimFor(suspended.id)
  assert.ok(claimed)
  // Suspended on an approval gate: no outcome, so the claim stays open.
  await recordPreparedCardOutcome(prisma, claimed, { pendingApproval: { approvalId: 'a-1' }, runId: suspended.id })

  const stranger = await prisma.run.create({ data: { agentId: s.agentId, status: 'running', threadId: s.threadId } })
  assert.equal(await claimFor(stranger.id), null)
  const continuation = await prisma.run.create({
    data: { agentId: s.agentId, continuationOfRunId: suspended.id, status: 'running', threadId: s.threadId },
  })
  const approved = await claimFor(continuation.id)
  assert.deepEqual(approved?.call, claimed.call, 'the exact prepared call, so the approval proof matches')
  const row = await prisma.agentCard.findUniqueOrThrow({ where: { id: posted.cardId } })
  assert.deepEqual(row.preparedExecution, { runId: continuation.id })
})
