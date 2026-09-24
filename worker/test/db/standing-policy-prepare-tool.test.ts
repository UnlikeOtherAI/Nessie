import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient, type Prisma } from '@prisma/client'
import { AgentCardSpecSchema, ExecutorCapabilityDescriptorSchema } from '@nessie/schemas'
import {
  AGENT_DESIGNER_BLUEPRINT,
  AGENT_DESIGNER_SLUG,
  createAgentTrigger,
  ensureGlobalAgentBootstrap,
} from '@nessie/team-admin'

import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { RunContext } from '../../src/run/execute/types.js'
import { runExecutorStandingPolicyPrepareTool } from '../../src/run/pa-tools/provisioning-standing-policy.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { runDatabaseTest } from './support.js'

/**
 * `executor_standing_policy_prepare` from the Agent Designer
 * (docs/standards/ticket-work.md; docs/standards/agent-cards.md): prepared
 * only on the trigger's author's own interactive turn in their own Designer
 * conversation, posting ONE card there that holds only the change's id, and
 * refused — with nothing written — in a shared room, on an unattended run, in
 * someone else's Designer conversation, and for anyone but the author.
 */

type Home = { dmKey: string | null; id: string; projectId: string; teamId: string; threadId: string }

const seed = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const [author, colleague] = await Promise.all(['Ondrej', 'Colleague'].map((displayName) => prisma.user.create({
    data: { displayName, email: `${displayName.toLowerCase()}-${suffix}@example.test` },
  })))
  const organization = await prisma.organization.create({ data: { name: `standing-tool-${suffix}` } })
  const organizationId = organization.id
  await prisma.organizationMember.createMany({
    data: [
      { organizationId, role: 'owner', userId: author!.id },
      { organizationId, role: 'member', userId: colleague!.id },
    ],
  })
  const project = await prisma.project.create({ data: { name: `project-${suffix}`, organizationId } })
  await prisma.projectMember.create({ data: { projectId: project.id, role: 'member', userId: colleague!.id } })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const board = await prisma.board.create({
    data: { isDefault: true, name: 'Engineering', organizationId, position: 0, projectId: project.id },
  })
  for (const [name, category, position] of [['Backlog', 'todo', 0], ['In progress', 'in_progress', 1], ['Done', 'done', 2]] as const) {
    await prisma.boardColumn.create({ data: { boardId: board.id, category, name, organizationId, position } })
  }
  const channel = await prisma.channel.create({
    data: {
      label: 'eng', organizationId, projectId: project.id, slug: `eng-${suffix}`, teamId: team.id, visibility: 'public',
    },
  })
  const channelThread = await prisma.thread.create({ data: { channelId: channel.id } })
  const cto = await prisma.agent.create({ data: { name: 'CTO', organizationId, projectId: project.id } })
  await prisma.agentBinding.create({ data: { agentId: cto.id, channelId: channel.id } })
  const trigger = await createAgentTrigger(prisma, cto.id, {
    config: { instructions: { general: 'Have Claude fix it and merge on green.' }, pickup: { columns: [{ name: 'In progress' }] } },
    name: 'Pick up tickets',
    targetChannelId: channel.id,
    type: 'ticket_changed',
  }, { authorUserId: author!.id })
  assert.ok(trigger, 'the ticket trigger was created')
  const descriptor = ExecutorCapabilityDescriptorSchema.parse({
    codingSessions: {
      agents: ['claude'], allowedToolCount: 2, configDigest: `sha256:${'c'.repeat(64)}`, environmentNames: [],
      maxBudgetUsd: { claude: 5 }, maxLiveSessionsPerOwner: 3,
      mergeCommands: ['git push', 'gh pr create', 'gh pr checks', 'gh pr merge'],
      unaskedCommands: 'listed',
      permissionMode: { claude: 'acceptEdits' }, rootNames: ['nessie'], serverName: 'coding-sessions',
    },
    limits: { maxCommandRuntimeSeconds: 30, maxResultBytes: 1024, maxSessions: 2 },
    localPolicyDigest: `sha256:${'1'.repeat(64)}`,
    mcpServers: ['coding-sessions'],
    operationKeys: ['mcp.tools', 'mcp.call'],
    platform: { architecture: 'x64', os: 'windows', osMajorVersion: 26100 },
    profiles: ['workspace_sandbox'],
    protocolVersion: 1,
    revision: 1,
    sandboxBackend: 'none',
    supervisor: 'service',
  })
  const executor = await prisma.executor.create({
    data: {
      capabilityRevisions: {
        create: {
          descriptor: descriptor as unknown as Prisma.InputJsonValue, localPolicyDigest: descriptor.localPolicyDigest,
          reviewStatus: 'active', revision: 1, signature: 'reviewed',
        },
      },
      label: 'Minis', lastSeenAt: new Date(), organizationId, pairingOwnerUserId: author!.id,
      privateAssignments: { create: { principalKind: 'user', role: 'admin', userId: author!.id } },
      profiles: ['workspace_sandbox'], scopeKind: 'private', status: 'online',
    },
  })
  const homeOf = async (userId: string): Promise<{ agentId: string; home: Home }> => {
    const bootstrap = await ensureGlobalAgentBootstrap(prisma, {
      blueprint: AGENT_DESIGNER_BLUEPRINT, organizationId, teamId: team.id, userId,
    })
    const home = await prisma.channel.findUniqueOrThrow({
      where: { id: bootstrap.channelId },
      select: { dmKey: true, id: true, projectId: true, teamId: true, threads: { select: { id: true } } },
    })
    return {
      agentId: bootstrap.agentId,
      home: {
        dmKey: home.dmKey, id: home.id, projectId: home.projectId, teamId: home.teamId,
        threadId: home.threads[0]!.id,
      },
    }
  }
  return {
    authorHome: await homeOf(author!.id),
    authorId: author!.id,
    channel: { id: channel.id, projectId: project.id, teamId: team.id, threadId: channelThread.id },
    colleagueHome: await homeOf(colleague!.id),
    colleagueId: colleague!.id,
    ctoId: cto.id,
    executorId: executor.id,
    organizationId,
    triggerId: trigger.id,
    cleanup: async () => {
      await prisma.executorContinuation.deleteMany({ where: { executorId: executor.id } })
      await prisma.executorStandingPolicy.deleteMany({ where: { organizationId } })
      await prisma.executor.deleteMany({ where: { id: executor.id } })
      await prisma.organization.deleteMany({ where: { id: organizationId } })
      await prisma.user.deleteMany({ where: { id: { in: [author!.id, colleague!.id] } } })
    },
  }
}
type Seed = Awaited<ReturnType<typeof seed>>

/** A tool call as run setup would build it: which agent, where, for whom, and whether a person is on the turn. */
const contextFor = async (
  prisma: PrismaClient,
  s: Seed,
  input: {
    agent: { id: string; kind: 'shared'; name: string; systemSlug: string | null }
    channel: { dmKey: string | null; id: string; projectId: string; systemChannelType: string | null; teamId: string }
    interactive: boolean
    requesterId: string
    threadId: string
  },
): Promise<BuiltinToolRuntimeContext> => {
  const run = await prisma.run.create({ data: { agentId: input.agent.id, status: 'running', threadId: input.threadId } })
  const consumedSources = createConsumedSourceSink()
  const runContext: RunContext = {
    agent: {
      agentKind: input.agent.kind, effort: 'medium', executionMode: 'inference', id: input.agent.id, model: null,
      name: input.agent.name, parentAgentId: null, provider: null, systemPrompt: null,
      systemSlug: input.agent.systemSlug,
    },
    boundAgentIds: [],
    channel: {
      dmKey: input.channel.dmKey, id: input.channel.id, organizationId: s.organizationId,
      projectId: input.channel.projectId, systemChannelType: input.channel.systemChannelType,
      teamId: input.channel.teamId, visibility: input.channel.systemChannelType ? 'private' : 'public',
    },
    consumedSources,
    run: { createdAt: new Date(), id: run.id, replyPlacement: null, threadId: input.threadId },
    task: { id: randomUUID() },
  } as RunContext
  return {
    actorContext: {
      actionContext: {
        effectiveUserId: input.requesterId,
        ...(input.interactive ? { interactive: true } : {}),
        requestId: randomUUID(),
      },
      actor: { actorId: input.requesterId, actorType: 'user' },
      tenant: { organizationId: s.organizationId, projectId: input.channel.projectId, teamId: input.channel.teamId },
    },
    agentId: input.agent.id,
    agentKind: input.agent.kind,
    channel: {
      id: input.channel.id, organizationId: s.organizationId, systemChannelType: input.channel.systemChannelType,
    },
    consumedSources,
    ledgerIdentity: null,
    prisma,
    realtimeTransport: { publishWs: async () => undefined },
    run: {
      id: run.id, interactive: input.interactive, messageId: randomUUID(), originatingUserId: input.requesterId,
      threadId: input.threadId,
    },
    runContext,
    toolCallId: randomUUID(),
  } as unknown as BuiltinToolRuntimeContext
}

const designerIn = (s: Seed, who: 'author' | 'colleague', interactive = true) => {
  const { agentId, home } = who === 'author' ? s.authorHome : s.colleagueHome
  return {
    agent: { id: agentId, kind: 'shared' as const, name: 'Agent Designer', systemSlug: AGENT_DESIGNER_SLUG },
    channel: { ...home, systemChannelType: 'system_agent' },
    interactive,
    requesterId: who === 'author' ? s.authorId : s.colleagueId,
    threadId: home.threadId,
  }
}

// A confirmation token is 32 random bytes in base64url: 43 characters.
const TOKEN_SHAPE = /[A-Za-z0-9_-]{43}/

runDatabaseTest('the author\'s own Designer turn posts ONE card there that holds only the change id', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))

  const result = await runExecutorStandingPolicyPrepareTool(await contextFor(prisma, s, designerIn(s, 'author')), {
    executorIds: [s.executorId], triggerId: s.triggerId,
  })
  assert.equal(result.deliveredToConversation, true)
  assert.match(result.outputPreview, /put ONE confirmation card in this conversation/)
  assert.match(result.outputPreview, /with their password/)
  assert.doesNotMatch(result.outputPreview.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/, ''), TOKEN_SHAPE)

  const policy = await prisma.executorStandingPolicy.findFirstOrThrow({ where: { triggerId: s.triggerId } })
  assert.equal(policy.status, 'preparing')
  const continuation = await prisma.executorContinuation.findFirstOrThrow({ where: { executorId: s.executorId } })
  const card = await prisma.agentCard.findFirstOrThrow({
    where: { threadId: s.authorHome.home.threadId },
    select: { channelId: true, executorAccessChangeId: true, respondentUserIds: true, spec: true },
  })
  assert.equal(card.channelId, s.authorHome.home.id, 'in the author\'s own home DM')
  assert.equal(card.executorAccessChangeId, continuation.id)
  assert.deepEqual(card.respondentUserIds, [s.authorId])
  const spec = AgentCardSpecSchema.parse(card.spec)
  assert.equal(spec.title, 'Let CTO use Minis')
  assert.match(JSON.stringify(spec), /Anyone who can edit this board \(2 people\) can make Claude run commands/)
  assert.doesNotMatch(JSON.stringify(spec), TOKEN_SHAPE)
})

runDatabaseTest('a shared room, an unattended run, someone else\'s Designer and a non-author are each refused', async (t) => {
  const prisma = new PrismaClient()
  const s = await seed(prisma)
  t.after(() => s.cleanup().then(() => prisma.$disconnect()))
  const args = { executorIds: [s.executorId], triggerId: s.triggerId }
  const shared = await contextFor(prisma, s, {
    agent: { id: s.ctoId, kind: 'shared', name: 'CTO', systemSlug: null },
    channel: { ...s.channel, dmKey: null, systemChannelType: null },
    interactive: true,
    requesterId: s.authorId,
    threadId: s.channel.threadId,
  })
  await assert.rejects(runExecutorStandingPolicyPrepareTool(shared, args), /only by the person who set up the trigger/)
  const unattended = await contextFor(prisma, s, designerIn(s, 'author', false))
  await assert.rejects(runExecutorStandingPolicyPrepareTool(unattended, args), /on their own turn/)
  // The colleague's own Designer: the surface is theirs, the trigger is not.
  const colleague = await contextFor(prisma, s, designerIn(s, 'colleague'))
  await assert.rejects(runExecutorStandingPolicyPrepareTool(colleague, args),
    /Only Ondrej, who set this trigger up, can set up machine access for it/)
  // The author's DM, but a turn somebody else asked for.
  const borrowed = await contextFor(prisma, s, { ...designerIn(s, 'author'), requesterId: s.colleagueId })
  await assert.rejects(runExecutorStandingPolicyPrepareTool(borrowed, args))
  assert.equal(await prisma.executorStandingPolicy.count({ where: { organizationId: s.organizationId } }), 0)
  assert.equal(await prisma.agentCard.count({ where: { organizationId: s.organizationId } }), 0)
})
