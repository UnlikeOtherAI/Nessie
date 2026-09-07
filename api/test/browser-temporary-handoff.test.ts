import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '@prisma/client'
import { createPersonalBrowserAccessGrant } from '@nessie/browser-cloud'
import { BROWSER_OPEN_TOOL_ID } from '@nessie/runtime'

import { createRequestHelpers } from '../src/lib/request-helpers.js'
import {
  AgentCardResponseError,
  respondToAgentCard,
} from '../src/services/agent-card-response.js'
import {
  sweepExpiredAgentCards,
  sweepExpiredTemporaryBrowserLoginCards,
} from '../src/services/agent-card-sweep.js'
import { requestRunCancellation } from '../src/services/runs.js'
import { findTemporaryBrowserLoginCardForViewer } from '../src/services/browser-login-card-selection.js'

const runDatabaseTest = process.env.DATABASE_URL ? test : test.skip

type Fixture = {
  actorContext: {
    actionContext: { requestId: string }
    actor: { actorId: string; actorType: 'user'; roles: ['owner'] }
    tenant: { organizationId: string }
  }
  cardId: string
  deadline: Date
  grantId: string
  organizationId: string
  origins: string[]
  prisma: PrismaClient
  runId: string
  sessionId: string
  threadId: string
  userId: string
}

const seedTemporaryHandoff = async (t: test.TestContext): Promise<Fixture> => {
  const prisma = new PrismaClient()
  const suffix = randomUUID()
  const organization = await prisma.organization.create({ data: { name: `temporary-handoff-${suffix}` } })
  const user = await prisma.user.create({
    data: { displayName: 'Private owner', email: `temporary-handoff-${suffix}@example.test` },
  })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: user.id },
  })
  const project = await prisma.project.create({
    data: { name: `project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const channel = await prisma.channel.create({
    data: {
      label: `private-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      slug: `private-${suffix.slice(0, 8)}`,
      teamId: team.id,
      type: 'dm',
      visibility: 'private',
    },
  })
  await prisma.channelMember.create({ data: { channelId: channel.id, userId: user.id } })
  const thread = await prisma.thread.create({ data: { channelId: channel.id, title: 'Private browser login' } })
  const agent = await prisma.agent.create({
    data: {
      name: `private-agent-${suffix}`,
      organizationId: organization.id,
      ownerUserId: user.id,
      projectId: project.id,
      teamId: team.id,
      toolPolicy: { [BROWSER_OPEN_TOOL_ID]: true },
      visibility: 'private',
    },
  })
  await prisma.channel.update({
    where: { id: channel.id },
    data: { dmKey: `agent:${organization.id}:${user.id}:${agent.id}` },
  })
  await prisma.agentBinding.create({
    data: { agentId: agent.id, channelId: channel.id, principalUserId: null },
  })
  const message = await prisma.message.create({
    data: { agentId: agent.id, content: 'Please sign in.', role: 'assistant', threadId: thread.id },
  })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'waiting_input', threadId: thread.id, triggerMessageId: message.id },
  })
  await prisma.runCheckpoint.create({
    data: {
      agentId: agent.id,
      note: 'Waiting for private sign-in.',
      organizationId: organization.id,
      reason: 'waiting_input',
      runId: run.id,
      threadId: thread.id,
    },
  })
  const connection = await prisma.cloudBrowserConnection.create({
    data: {
      apiKeyRef: `secret_test_${suffix}`,
      createdByUserId: user.id,
      organizationId: organization.id,
      scope: 'user',
      userId: user.id,
    },
  })
  const deadline = new Date(Date.now() + 60_000)
  const session = await prisma.cloudBrowserSession.create({
    data: {
      agentId: agent.id,
      authenticated: true,
      browserbaseSessionId: `browserbase-${suffix}`,
      connectionId: connection.id,
      controlledByUserId: user.id,
      controlClaimedAt: new Date(),
      expiresAt: deadline,
      interactionTransport: 'mediated',
      organizationId: organization.id,
      requestedByUserId: user.id,
      status: 'active',
      threadId: thread.id,
    },
  })
  const origins = ['https://signin.example.test', 'https://app.example.test']
  const grant = await createPersonalBrowserAccessGrant(prisma, {
    agentId: agent.id,
    expiresAt: deadline,
    organizationId: organization.id,
    origins,
    runId: run.id,
    threadId: thread.id,
    userId: user.id,
  })
  await prisma.browserPersonalAccessGrant.update({
    where: { id: grant.grantId },
    data: { activatedAt: new Date(), sessionId: session.id, status: 'active' },
  })
  const actorContext = {
    actionContext: { requestId: `temporary-handoff-${suffix}` },
    actor: { actorId: user.id, actorType: 'user' as const, roles: ['owner'] as ['owner'] },
    tenant: { organizationId: organization.id },
  }
  const card = await prisma.agentCard.create({
    data: {
      agentId: agent.id,
      browserLogin: { grantId: grant.grantId, mode: 'temporary', origins: grant.origins, service: 'Example' },
      channelId: channel.id,
      expiresAt: grant.expiresAt,
      messageId: message.id,
      organizationId: organization.id,
      respondentUserIds: [user.id],
      resumeState: { actorContext, interactive: true, messageId: message.id },
      runId: run.id,
      spec: {
        actions: [{ key: 'done', label: 'Done', style: 'primary', submits: true }],
        blocks: [{ markdown: 'Sign in, then choose Done.', type: 'text' }],
        schemaVersion: 1,
        title: 'Private sign-in',
      },
      status: 'open',
      threadId: thread.id,
      waitRunId: run.id,
    },
  })
  t.after(async () => {
    await prisma
      .$executeRaw`DELETE FROM queue_jobs WHERE payload->>'threadId' = ${thread.id}`
      .catch(() => undefined)
    await prisma.organization.deleteMany({ where: { id: organization.id } })
    await prisma.user.deleteMany({ where: { id: user.id } })
    await prisma.$disconnect()
  })
  return {
    actorContext,
    cardId: card.id,
    deadline: grant.expiresAt,
    grantId: grant.grantId,
    organizationId: organization.id,
    origins: grant.origins,
    prisma,
    runId: run.id,
    sessionId: session.id,
    threadId: thread.id,
    userId: user.id,
  }
}

runDatabaseTest('temporary Done binds its one private session to its exact continuation once', async (t) => {
  const fixture = await seedTemporaryHandoff(t)
  const card = await findTemporaryBrowserLoginCardForViewer(fixture.prisma, {
    organizationId: fixture.organizationId,
    sessionId: fixture.sessionId,
    threadId: fixture.threadId,
    userId: fixture.userId,
  })
  assert.ok(card)
  assert.equal(card.id, fixture.cardId)

  const deps = {
    ...createRequestHelpers(fixture.prisma),
    authSecret: 'temporary-handoff-test',
    dashboardCredentials: {},
    mcpSecretStore: {},
    messageMemoryCaptureConfig: null,
    prisma: fixture.prisma,
    realtimeHub: { publishWs: async () => undefined },
  }
  const outcome = await respondToAgentCard(deps as never, {
    actionKey: 'done',
    actorContext: fixture.actorContext,
    card,
    handoverSessionId: fixture.sessionId,
  })
  assert.equal(outcome.status, 'resolved')

  const successor = await fixture.prisma.run.findFirst({
    select: { id: true },
    where: { continuationOfRunId: fixture.runId },
  })
  assert.ok(successor, 'Done creates a successor rather than reusing the parked run')
  const [storedCard, grant, session] = await Promise.all([
    fixture.prisma.agentCard.findUniqueOrThrow({
      select: { resumedByRunId: true, waitRunId: true },
      where: { id: fixture.cardId },
    }),
    fixture.prisma.browserPersonalAccessGrant.findUniqueOrThrow({
      select: {
        agentId: true,
        expiresAt: true,
        organizationId: true,
        origins: true,
        runId: true,
        threadId: true,
        userId: true,
      },
      where: { id: fixture.grantId },
    }),
    fixture.prisma.cloudBrowserSession.findUniqueOrThrow({
      select: { controlledByUserId: true, runId: true },
      where: { id: fixture.sessionId },
    }),
  ])
  assert.deepEqual(storedCard, { resumedByRunId: successor.id, waitRunId: fixture.runId })
  assert.equal(session.runId, successor.id)
  assert.equal(session.controlledByUserId, null)
  assert.deepEqual(
    {
      agentId: grant.agentId,
      organizationId: grant.organizationId,
      origins: grant.origins,
      threadId: grant.threadId,
      userId: grant.userId,
    },
    {
      agentId: card.agentId,
      organizationId: fixture.organizationId,
      origins: fixture.origins,
      threadId: fixture.threadId,
      userId: fixture.userId,
    },
  )
  assert.equal(grant.runId, successor.id)
  assert.equal(grant.expiresAt.getTime(), fixture.deadline.getTime())

  await assert.rejects(
    () => respondToAgentCard(deps as never, {
      actionKey: 'done',
      actorContext: fixture.actorContext,
      card,
      handoverSessionId: fixture.sessionId,
    }),
    (error: unknown) => error instanceof AgentCardResponseError && error.code === 'CARD_NOT_OPEN',
  )
  assert.equal(
    await fixture.prisma.run.count({ where: { continuationOfRunId: fixture.runId } }),
    1,
    'replaying Done cannot create a second successor',
  )
})

runDatabaseTest('an expired temporary login card cancels only its waiting run and releases its session', async (t) => {
  const fixture = await seedTemporaryHandoff(t)
  const [{ agentId }, { channelId }] = await Promise.all([
    fixture.prisma.run.findUniqueOrThrow({
      where: { id: fixture.runId }, select: { agentId: true },
    }),
    fixture.prisma.thread.findUniqueOrThrow({
      where: { id: fixture.threadId }, select: { channelId: true },
    }),
  ])
  const historicalMessageIds = Array.from({ length: 200 }, () => randomUUID())
  await fixture.prisma.message.createMany({
    data: historicalMessageIds.map((id) => ({
      content: 'Expired historical login card.', id, role: 'assistant', threadId: fixture.threadId,
    })),
  })
  await fixture.prisma.agentCard.createMany({
    data: historicalMessageIds.map((messageId) => ({
      agentId,
      browserLogin: { mode: 'temporary' },
      channelId,
      id: randomUUID(),
      messageId,
      organizationId: fixture.organizationId,
      runId: fixture.runId,
      spec: {
        actions: [{ key: 'done', label: 'Done', style: 'primary', submits: true }],
        blocks: [{ markdown: 'Expired history.', type: 'text' }],
        schemaVersion: 1,
        title: 'Historical card',
      },
      status: 'expired',
      threadId: fixture.threadId,
    })),
  })
  const ordinaryMessage = await fixture.prisma.message.create({
    data: { content: 'Ordinary expired card.', role: 'assistant', threadId: fixture.threadId },
  })
  const ordinaryCard = await fixture.prisma.agentCard.create({
    data: {
      agentId,
      channelId,
      expiresAt: new Date(Date.now() - 1_000),
      messageId: ordinaryMessage.id,
      organizationId: fixture.organizationId,
      spec: {
        actions: [{ key: 'done', label: 'Done', style: 'primary', submits: true }],
        blocks: [{ markdown: 'Ordinary expiry.', type: 'text' }],
        schemaVersion: 1,
        title: 'Ordinary card',
      },
      threadId: fixture.threadId,
    },
  })
  await fixture.prisma.agentCard.update({
    where: { id: fixture.cardId },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  })
  const released: string[] = []

  const expired = await sweepExpiredTemporaryBrowserLoginCards({
    encryptionSecret: 'temporary-handoff-test',
    prisma: fixture.prisma,
    resolveSecret: async () => 'browserbase-test-key',
    clientFactory: () => ({
      endSession: async (sessionId: string) => { released.push(sessionId) },
    }) as never,
  }, async ({ organizationId, runId, userId }) => {
    await requestRunCancellation(fixture.prisma, {
      cancelledByUserId: userId,
      organizationId,
      runId,
    })
  })

  assert.deepEqual(expired, [fixture.cardId])
  const [card, grant, run, session] = await Promise.all([
    fixture.prisma.agentCard.findUniqueOrThrow({
      where: { id: fixture.cardId }, select: { status: true },
    }),
    fixture.prisma.browserPersonalAccessGrant.findUniqueOrThrow({
      where: { id: fixture.grantId }, select: { status: true },
    }),
    fixture.prisma.run.findUniqueOrThrow({
      where: { id: fixture.runId }, select: { status: true },
    }),
    fixture.prisma.cloudBrowserSession.findUniqueOrThrow({
      where: { id: fixture.sessionId }, select: { status: true },
    }),
  ])
  assert.equal(card.status, 'expired')
  assert.equal(grant.status, 'expired')
  assert.equal(run.status, 'cancelled')
  assert.equal(session.status, 'released')
  assert.deepEqual(released, [fixture.sessionId])
  assert.equal(
    (await fixture.prisma.agentCard.findUniqueOrThrow({
      where: { id: ordinaryCard.id }, select: { status: true },
    })).status,
    'open',
    'the temporary sweep leaves ordinary expiry to the general card lifecycle',
  )
  assert.deepEqual(await sweepExpiredAgentCards(fixture.prisma), [ordinaryCard.id])
})
