import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { BROWSER_LOGIN_REQUEST_TOOL_ID } from '@nessie/runtime'
import { AgentCardSpecSchema } from '@nessie/schemas'
import { createAgentRecord, renderAgentCardPlainText } from '@nessie/team-admin'

import { cloudBrowserTool } from '../../src/run/browser-cloud/browser-tools.js'
import { requestBrowserLogin } from '../../src/run/browser-cloud/login-request.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { RunContext } from '../../src/run/execute/types.js'
import { postAgentCard } from '../../src/run/pa-tools/agent-card-post.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

/**
 * `browser_login_request`'s card, against real rows, from a private agent's
 * own home DM — the only surface personal browser state may reach.
 *
 * It used to write its message, card and pointer through a copy of the card
 * code; it now posts through the one `postAgentCard` door, with the access
 * grant inside the card's own transaction. What this pins is that the move
 * changed nothing a person or the API reads: the same card, the same message
 * and pointer, the grant the card names, the grant's deadline as the card's,
 * the requester alone as respondent, one realtime notice, the requester's
 * bell — and, through the tool's own dispatcher, a result that parks the run
 * on that card.
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
    data: { displayName: 'Owner', email: `browser-login-card-${suffix}@example.test` },
  })
  const organization = await prisma.organization.create({ data: { name: `browser-login-card-${suffix}` } })
  await prisma.organizationMember.create({
    data: { organizationId: organization.id, role: 'owner', userId: owner.id },
  })
  const project = await prisma.project.create({ data: { name: `project-${suffix}`, organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  // A private agent is created with its home: the one-person DM the private
  // browser check (`isPrivateBrowserHome`) accepts.
  const agent = await createAgentRecord(prisma, {
    name: 'Scout',
    organizationId: organization.id,
    ownerUserId: owner.id,
    role: 'researcher',
    teamId: team.id,
    visibility: 'private',
  })
  assert.ok(agent.homeChannelId, 'a private agent is created with its home')
  const home = await prisma.channel.findUniqueOrThrow({
    where: { id: agent.homeChannelId },
    select: { id: true, threads: { select: { id: true } } },
  })
  const threadId = home.threads[0]?.id
  assert.ok(threadId, 'the home DM has its default thread')
  const run = await prisma.run.create({ data: { agentId: agent.id, status: 'running', threadId } })
  return {
    agentId: agent.id,
    homeId: home.id,
    organizationId: organization.id,
    ownerId: owner.id,
    projectId: project.id,
    runId: run.id,
    teamId: team.id,
    threadId,
  }
}

const cleanup = async (prisma: PrismaClient, s: Seed): Promise<void> => {
  await prisma.organization.deleteMany({ where: { id: s.organizationId } })
  await prisma.user.deleteMany({ where: { id: s.ownerId } })
}

type Published = { data?: unknown; event: string }

/** The private agent, on its owner's interactive turn in its own home. */
const homeContext = (
  prisma: PrismaClient,
  s: Seed,
  published: Published[],
): BuiltinToolRuntimeContext => {
  const consumedSources = createConsumedSourceSink()
  const runContext: RunContext = {
    agent: {
      agentKind: 'shared',
      effort: 'medium',
      executionMode: 'inference',
      id: s.agentId,
      model: null,
      name: 'Scout',
      ownerUserId: s.ownerId,
      parentAgentId: null,
      provider: null,
      systemPrompt: null,
      visibility: 'private',
    },
    boundAgentIds: [],
    channel: {
      dmKey: `agent:${s.organizationId}:${s.ownerId}:${s.agentId}`,
      id: s.homeId,
      organizationId: s.organizationId,
      projectId: s.projectId,
      systemChannelType: null,
      teamId: s.teamId,
      visibility: 'private',
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
    realtimeTransport: {
      publishWs: async (_scopes: unknown, payload: Published) => {
        published.push(payload)
      },
    },
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

runDatabaseTest('the sign-in card, its message and its grant are written as one', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => cleanup(prisma, s).then(() => prisma.$disconnect()))
  const published: Published[] = []

  const outcome = await requestBrowserLogin(
    { prisma, resolveSecret: async () => null },
    homeContext(prisma, s, published),
    { origins: ['https://app.example.com'], reason: 'Read the release notes', service: 'Example' },
  )

  assert.equal(outcome.success, true, outcome.output)
  assert.ok(outcome.cardId)
  assert.match(outcome.output, /^Asked for a sign-in to Example\./)

  const card = await prisma.agentCard.findUniqueOrThrow({
    where: { id: outcome.cardId },
    select: {
      browserLogin: true,
      channelId: true,
      expiresAt: true,
      message: { select: { content: true, id: true, metadata: true, role: true } },
      respondentUserIds: true,
      runId: true,
      spec: true,
      status: true,
      threadId: true,
    },
  })
  const expectedSpec = {
    actions: [{ key: 'done', label: 'Done', style: 'primary', submits: true }],
    blocks: [{
      markdown: 'Open your private browser, sign in to Example, then press Done. '
        + 'Done lets the agent continue this task.',
      type: 'text',
    }],
    schemaVersion: 1,
    subtitle: 'Read the release notes',
    title: 'Sign in to Example',
  }
  assert.deepEqual(AgentCardSpecSchema.parse(card.spec), AgentCardSpecSchema.parse(expectedSpec))
  assert.equal(card.status, 'open')
  assert.equal(card.channelId, s.homeId)
  assert.equal(card.threadId, s.threadId)
  assert.equal(card.runId, s.runId)
  assert.deepEqual(card.respondentUserIds, [s.ownerId], 'only the person who asked can press Done')

  // The message and its pointer, the way every card's are.
  assert.equal(card.message.role, 'assistant')
  assert.equal(card.message.content, renderAgentCardPlainText(AgentCardSpecSchema.parse(expectedSpec)))
  assert.deepEqual(card.message.metadata, { agentCard: { cardId: outcome.cardId, schemaVersion: 1 } })

  // The grant the card names, for this person, agent, run and origin only —
  // and its deadline, not the requested fifteen minutes, is the card's.
  const grant = await prisma.browserPersonalAccessGrant.findFirstOrThrow({
    where: { runId: s.runId },
    select: { agentId: true, expiresAt: true, id: true, origins: true, threadId: true, userId: true },
  })
  assert.deepEqual(card.browserLogin, {
    grantId: grant.id,
    mode: 'temporary',
    origins: ['https://app.example.com'],
    service: 'Example',
  })
  assert.deepEqual(
    { agentId: grant.agentId, origins: grant.origins, threadId: grant.threadId, userId: grant.userId },
    { agentId: s.agentId, origins: ['https://app.example.com'], threadId: s.threadId, userId: s.ownerId },
  )
  assert.equal(card.expiresAt?.getTime(), grant.expiresAt.getTime())

  // The new message is announced once, as every card's is.
  const announced = published.filter((payload) =>
    payload.event === 'message.new' && JSON.stringify(payload.data).includes(card.message.id))
  assert.equal(announced.length, 1)

  // The requester's bell: one durable mention alert, and its realtime notice.
  assert.deepEqual(
    await prisma.userAlert.findMany({
      where: { messageId: card.message.id },
      select: { kind: true, threadId: true, userId: true },
    }),
    [{ kind: 'mention', threadId: s.threadId, userId: s.ownerId }],
  )
  const rung = published.filter((payload) =>
    payload.event === 'alert.created' && JSON.stringify(payload.data).includes(card.message.id))
  assert.equal(rung.length, 1)
})

// The tool as the loop dispatches it: its result parks the run on the card it
// just posted, so the run waits for Done rather than carrying on.
runDatabaseTest('browser_login_request parks its run on the card it posted', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => cleanup(prisma, s).then(() => prisma.$disconnect()))

  const result = await cloudBrowserTool(
    BROWSER_LOGIN_REQUEST_TOOL_ID,
    { origins: ['https://app.example.com'], reason: 'Read the release notes', service: 'Example' },
    { ...homeContext(prisma, s, []), cloudBrowser: { prisma, resolveSecret: async () => null } },
  )

  assert.ok(result, 'the cloud browser dispatcher owns browser_login_request')
  assert.equal(result.success, true, result.output)
  const card = await prisma.agentCard.findFirstOrThrow({ where: { runId: s.runId }, select: { id: true } })
  assert.deepEqual(result.pendingInput, { cardId: card.id })
})

// The grant runs inside the card's transaction: a grant that cannot be written
// leaves no card asking for a sign-in nobody could complete, and no message.
runDatabaseTest('a sign-in grant that fails takes its card and message with it', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => cleanup(prisma, s).then(() => prisma.$disconnect()))
  const context = homeContext(prisma, s, [])
  const messagesBefore = await prisma.message.count({ where: { threadId: s.threadId } })

  await assert.rejects(
    postAgentCard(context, context.runContext as RunContext, {
      browserLogin: async (tx) => {
        await tx.browserPersonalAccessGrant.create({
          data: {
            agentId: s.agentId,
            expiresAt: new Date(Date.now() + 60_000),
            organizationId: s.organizationId,
            origins: ['https://app.example.com'],
            runId: s.runId,
            threadId: s.threadId,
            userId: s.ownerId,
          },
        })
        throw new Error('the grant was refused')
      },
      card: {
        actions: [{ key: 'done', label: 'Done', style: 'primary', submits: true }],
        blocks: [{ markdown: 'Sign in, then press Done.', type: 'text' }],
        schemaVersion: 1,
        title: 'Sign in to Example',
      },
      expiresAt: new Date(Date.now() + 60_000),
      respondentUserIds: [s.ownerId],
    }),
    /the grant was refused/,
  )

  assert.equal(await prisma.agentCard.count({ where: { threadId: s.threadId } }), 0)
  assert.equal(await prisma.message.count({ where: { threadId: s.threadId } }), messagesBefore)
  assert.equal(await prisma.browserPersonalAccessGrant.count({ where: { runId: s.runId } }), 0)
})

const DONE_CARD = {
  actions: [{ key: 'done', label: 'Done', style: 'primary' as const, submits: true }],
  blocks: [{ markdown: 'Press Done when it is done.', type: 'text' as const }],
  schemaVersion: 1 as const,
  title: 'Tell me when it is done',
}

// Once the card's transaction commits, the card is the durable truth. A step
// that fails after it used to fail the tool call, so the model saw an error
// beside a live, answerable card, and posted it again.
runDatabaseTest('a notice that fails after the card committed still answers with the card', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => cleanup(prisma, s).then(() => prisma.$disconnect()))

  // The realtime insert fails: nothing is announced, and the card still stands.
  const offline = homeContext(prisma, s, [])
  const down = {
    ...offline,
    realtimeTransport: { publishWs: async () => { throw new Error('realtime_events insert failed') } },
  } as unknown as BuiltinToolRuntimeContext
  const posted = await postAgentCard(down, down.runContext as RunContext, {
    card: DONE_CARD, expiresAt: null, respondentUserIds: [s.ownerId],
  })
  const card = await prisma.agentCard.findUniqueOrThrow({
    where: { id: posted.cardId }, select: { messageId: true, status: true },
  })
  assert.deepEqual(card, { messageId: posted.messageId, status: 'open' })
  assert.equal(await prisma.userAlert.count({ where: { messageId: posted.messageId } }), 1,
    'the bell is written though its notice could not be sent')
})

runDatabaseTest('reply bookkeeping that fails after the card committed still announces and answers', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => cleanup(prisma, s).then(() => prisma.$disconnect()))

  // The card is still announced, only without its place in the reply thread,
  // which the next read of the thread shows.
  const root = await prisma.message.create({
    data: { content: 'Ping me when it is done', role: 'user', threadId: s.threadId, userId: s.ownerId },
  })
  const published: Published[] = []
  const replying = homeContext(new Proxy(prisma, {
    get: (target, property) => {
      if (property === '$queryRaw') return async () => { throw new Error('reply bookkeeping failed') }
      const value = Reflect.get(target, property) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }), s, published)
  const runContext = { ...(replying.runContext as RunContext), replyRootMessageId: root.id }
  const reply = await postAgentCard(replying, runContext, {
    card: DONE_CARD, expiresAt: null, respondentUserIds: [s.ownerId],
  })
  assert.equal((await prisma.message.findUniqueOrThrow({ where: { id: reply.messageId } })).rootMessageId, root.id)
  assert.equal(published.filter((payload) =>
    payload.event === 'message.new' && JSON.stringify(payload.data).includes(reply.messageId)).length, 1)
})
