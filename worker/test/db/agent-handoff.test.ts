import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { AGENT_HANDOFF_TOOL_ID, BUILTIN_TOOL_DEFINITIONS, viewerSatisfiesBasis } from '@nessie/runtime'
import { resolveDisclosureViewer } from '@nessie/runtime'
import {
  AGENT_DESIGNER_BLUEPRINT,
  AGENT_DESIGNER_SLUG,
  globalAgentHomeDmKey,
} from '@nessie/team-admin'

import { runAgentHandoffTool } from '../../src/run/pa-tools/agent-handoff.js'
import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import { resolveAgentTools } from '../../src/run/tool-policy.js'
import type { RunContext } from '../../src/run/execute/types.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'
import { deleteThreadQueueJobs, runDatabaseTest } from './support.js'

/**
 * `agent_handoff` against the rows it actually writes (D8).
 *
 * What a fake cannot prove: that the DM the handoff opens is keyed on the
 * REQUESTING person rather than the run's effective user, that a second call
 * converges on the one briefing instead of stacking a duplicate, that a busy
 * home DM pends through `claimThreadRunOrPend` instead of double-running, and
 * that the brief's basis subtraction leaves the specialist's own reply readable
 * by the only member of its DM.
 *
 * Cleanup is scoped to each test's own organisation and its own thread's queue
 * jobs — no global delete, no global count assertion.
 */

type Seed = {
  agentId: string
  channelId: string
  memberId: string
  organizationId: string
  ownerId: string
  projectId: string
  runId: string
  teamId: string
  threadId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const suffix = randomUUID()
  const organization = await prisma.organization.create({
    data: { name: `handoff-${suffix}` },
  })
  const [owner, member] = await Promise.all([
    prisma.user.create({
      data: { displayName: 'Owner', email: `handoff-owner-${suffix}@example.test` },
    }),
    prisma.user.create({
      data: { displayName: 'Member', email: `handoff-member-${suffix}@example.test` },
    }),
  ])
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'owner', userId: owner.id },
      { organizationId: organization.id, role: 'member', userId: member.id },
    ],
  })
  const project = await prisma.project.create({
    data: { name: `handoff-project-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `handoff-team-${suffix}`, projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: 'ops',
      members: { create: [{ userId: owner.id }, { userId: member.id }] },
      organizationId: organization.id,
      projectId: project.id,
      slug: `handoff-ops-${suffix}`,
      teamId: team.id,
      visibility: 'private',
    },
  })
  const thread = await prisma.thread.create({
    data: { channelId: channel.id, title: 'general' },
  })
  const agent = await prisma.agent.create({
    data: {
      agentKind: 'shared',
      name: `Ops agent ${suffix}`,
      organizationId: organization.id,
      role: 'ops',
    },
  })
  const run = await prisma.run.create({
    data: { agentId: agent.id, status: 'running', threadId: thread.id },
  })

  return {
    agentId: agent.id,
    channelId: channel.id,
    memberId: member.id,
    organizationId: organization.id,
    ownerId: owner.id,
    projectId: project.id,
    runId: run.id,
    teamId: team.id,
    threadId: thread.id,
  }
}

const cleanup = async (prisma: PrismaClient, team: Seed): Promise<void> => {
  const designerThreads = await prisma.thread.findMany({
    where: { channel: { organizationId: team.organizationId } },
    select: { id: true },
  })
  for (const thread of designerThreads) {
    await deleteThreadQueueJobs(prisma, thread.id)
  }
  await prisma.organization.deleteMany({ where: { id: team.organizationId } })
  await prisma.user.deleteMany({
    where: { id: { in: [team.memberId, team.ownerId] } },
  })
}

const buildContext = (
  prisma: PrismaClient,
  team: Seed,
  options: {
    /** The human doing the asking — the actor. */
    actorUserId?: string
    /** What the run is delegated to act as, which may be somebody else. */
    effectiveUserId?: string
    interactive?: boolean
    unattended?: boolean
    consumed?: { scopeId: string; scopeType: string }[]
  } = {},
): BuiltinToolRuntimeContext => {
  const consumedSources = createConsumedSourceSink()
  consumedSources.addAll(options.consumed ?? [])
  const actorContext = {
    actionContext: {
      ...(options.effectiveUserId ? { effectiveUserId: options.effectiveUserId } : {}),
      requestId: randomUUID(),
    },
    actor: options.unattended
      ? { actorId: team.agentId, actorType: 'agent' as const, roles: ['system'] }
      : {
        actorId: options.actorUserId ?? team.ownerId,
        actorType: 'user' as const,
        roles: ['member'],
      },
    tenant: {
      organizationId: team.organizationId,
      projectId: team.projectId,
      teamId: team.teamId,
    },
  }
  const runContext: RunContext = {
    agent: {
      agentKind: 'shared',
      effort: 'medium',
      executionMode: 'inference',
      id: team.agentId,
      model: null,
      name: 'Ops agent',
      parentAgentId: null,
      provider: null,
      systemPrompt: null,
    },
    boundAgentIds: [],
    channel: {
      dmKey: null,
      id: team.channelId,
      organizationId: team.organizationId,
      projectId: team.projectId,
      systemChannelType: null,
      teamId: team.teamId,
    },
    consumedSources,
    run: {
      createdAt: new Date(),
      id: team.runId,
      replyPlacement: null,
      threadId: team.threadId,
    },
    task: { id: randomUUID() },
  }

  return {
    actorContext: actorContext as BuiltinToolRuntimeContext['actorContext'],
    agentId: team.agentId,
    agentKind: 'shared',
    channel: {
      id: team.channelId,
      organizationId: team.organizationId as never,
      systemChannelType: null,
    },
    consumedSources,
    ledgerIdentity: null,
    prisma,
    realtimeTransport: {
      publishWs: async () => undefined,
    } as BuiltinToolRuntimeContext['realtimeTransport'],
    run: {
      id: team.runId,
      interactive: options.interactive ?? true,
      messageId: randomUUID(),
      threadId: team.threadId,
    },
    runContext,
    toolCallId: randomUUID(),
  }
}

const designerHome = async (
  prisma: PrismaClient,
  team: Seed,
  userId: string,
) =>
  prisma.channel.findUniqueOrThrow({
    where: {
      dmKey: globalAgentHomeDmKey({
        organizationId: team.organizationId,
        slug: AGENT_DESIGNER_SLUG,
        userId,
      }),
    },
    select: { id: true, threads: { select: { id: true } } },
  })

runDatabaseTest('a handoff writes one brief, one doorway and one run — and a repeat converges', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(async () => {
    await cleanup(prisma, team)
    await prisma.$disconnect()
  })

  const context = buildContext(prisma, team, {
    // A privileged source the requester themselves satisfies: this is exactly
    // what the subtraction exists for.
    consumed: [{ scopeId: team.ownerId, scopeType: 'user' }],
  })
  const first = await runAgentHandoffTool(context, {
    brief: 'They want an agent that triages inbound support mail every morning.',
    target: AGENT_DESIGNER_SLUG,
  })
  const firstOutput = JSON.parse(first.outputPreview) as { status: string; channelId: string }
  assert.equal(firstOutput.status, 'handed_off')

  const home = await designerHome(prisma, team, team.ownerId)
  assert.equal(firstOutput.channelId, home.id)
  const homeThreadId = home.threads[0]?.id
  assert.ok(homeThreadId)

  // Exactly one hidden brief, and it is a `system` row — never a `user` one
  // under the requester's id, which would render as their own words.
  const briefs = await prisma.message.findMany({
    where: { threadId: homeThreadId },
    select: { id: true, metadata: true, role: true, userId: true },
  })
  assert.equal(briefs.length, 1)
  assert.equal(briefs[0]?.role, 'system')
  assert.equal(briefs[0]?.userId, null)
  assert.equal(
    (briefs[0]?.metadata as { agentHandoff?: { requestedByUserId?: string } } | null)
      ?.agentHandoff?.requestedByUserId,
    undefined,
    'the brief metadata is namespaced under its own key, not the tool name',
  )

  // The requester satisfied every consumed scope, so the brief carries no basis
  // and the Designer's own replies in this DM stay readable by the only person
  // who can open it. This is the finding the review called sharpest.
  const briefBasis = await prisma.messageBasisScope.findMany({
    where: { messageId: briefs[0]?.id ?? '' },
    select: { scopeId: true, scopeType: true },
  })
  assert.deepEqual(briefBasis, [])
  const viewer = await resolveDisclosureViewer(
    prisma,
    team.organizationId,
    team.ownerId,
  )
  assert.equal(viewerSatisfiesBasis(briefBasis, viewer), true)

  // One doorway message back in the origin thread, carrying the deep link.
  const doorways = await prisma.message.findMany({
    where: { agentId: team.agentId, threadId: team.threadId },
    select: { metadata: true },
  })
  assert.equal(doorways.length, 1)
  assert.equal(
    (doorways[0]?.metadata as { agentHandoffDoorway?: { channelId?: string } } | null)
      ?.agentHandoffDoorway?.channelId,
    home.id,
  )

  const designerAgent = await prisma.agent.findFirstOrThrow({
    where: { organizationId: team.organizationId, systemSlug: AGENT_DESIGNER_SLUG },
    select: { id: true, systemSlug: true, toolPolicy: true },
  })
  assert.equal(
    await prisma.run.count({ where: { agentId: designerAgent.id, threadId: homeThreadId } }),
    1,
  )

  // The bootstrapped Designer row itself carries a slug, so `agent_handoff` is
  // omitted from its schema array — it cannot hand off to itself or a peer.
  const designerToolset = resolveAgentTools(
    new Set(
      BUILTIN_TOOL_DEFINITIONS.filter((tool) => tool.requiresExplicitGrant !== true)
        .map((tool) => tool.id),
    ),
    BUILTIN_TOOL_DEFINITIONS,
    designerAgent.toolPolicy as Record<string, boolean> | null,
    null,
    'shared',
    {
      agentSystemSlug: designerAgent.systemSlug,
      inlineToolLimit: BUILTIN_TOOL_DEFINITIONS.length,
    },
  )
  assert.equal(designerToolset.allowedIds.has(AGENT_HANDOFF_TOOL_ID), false)

  // A second ask inside the cooldown — a retry, a continuation run, or simply
  // the person repeating themselves — converges on the briefing already there.
  const second = await runAgentHandoffTool(
    buildContext(prisma, team),
    { brief: 'Same thing again, phrased differently.', target: AGENT_DESIGNER_SLUG },
  )
  const secondOutput = JSON.parse(second.outputPreview) as { status: string; channelId: string }
  assert.equal(secondOutput.status, 'already_open')
  assert.equal(secondOutput.channelId, home.id)
  assert.equal(await prisma.message.count({ where: { threadId: homeThreadId } }), 1)
  assert.equal(
    await prisma.message.count({
      where: { agentId: team.agentId, threadId: team.threadId },
    }),
    1,
  )
  assert.equal(
    await prisma.run.count({ where: { agentId: designerAgent.id, threadId: homeThreadId } }),
    1,
  )
  assert.equal(
    await prisma.agentHandoffRequest.count({
      where: { requestedByUserId: team.ownerId, targetSlug: AGENT_DESIGNER_SLUG },
    }),
    1,
  )
})

runDatabaseTest('a PA-presence handoff opens the ASKING member\'s DM, not the effective user\'s', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(async () => {
    await cleanup(prisma, team)
    await prisma.$disconnect()
  })

  // The shape that made this a review finding: a Personal Assistant present in
  // a shared room carries its OWNER's effectiveUserId while a different member
  // is the one talking to it.
  const output = JSON.parse(
    (await runAgentHandoffTool(
      buildContext(prisma, team, {
        actorUserId: team.memberId,
        effectiveUserId: team.ownerId,
      }),
      { brief: 'The member wants a standup-notes agent.', target: AGENT_DESIGNER_SLUG },
    )).outputPreview,
  ) as { channelId: string }

  const memberHome = await designerHome(prisma, team, team.memberId)
  assert.equal(output.channelId, memberHome.id)
  assert.equal(
    await prisma.channel.count({
      where: {
        dmKey: globalAgentHomeDmKey({
          organizationId: team.organizationId,
          slug: AGENT_DESIGNER_SLUG,
          userId: team.ownerId,
        }),
      },
    }),
    0,
    'the effective user\'s Designer DM must not have been opened or briefed',
  )
  assert.equal(
    await prisma.agentHandoffRequest.count({
      where: { requestedByUserId: team.memberId },
    }),
    1,
  )
})

runDatabaseTest('unattended, non-interactive and agent-authored runs cannot hand off', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(async () => {
    await cleanup(prisma, team)
    await prisma.$disconnect()
  })

  const args = { brief: 'Build me a triage agent.', target: AGENT_DESIGNER_SLUG }

  await assert.rejects(
    runAgentHandoffTool(buildContext(prisma, team, { interactive: false }), args),
    /live turn from the person themselves/,
  )
  await assert.rejects(
    runAgentHandoffTool(
      // A trigger-fired run: an agent actor replaying an absent creator.
      buildContext(prisma, team, {
        effectiveUserId: team.ownerId,
        unattended: true,
      }),
      args,
    ),
    /nobody to hand the conversation to/,
  )
  await assert.rejects(
    runAgentHandoffTool(buildContext(prisma, team), {
      brief: 'x',
      target: 'no-such-specialist',
    }),
    /no built-in specialist called/,
  )

  assert.equal(
    await prisma.agentHandoffRequest.count({
      where: { organizationId: team.organizationId },
    }),
    0,
  )
  assert.equal(
    await prisma.channel.count({
      where: { organizationId: team.organizationId, systemChannelType: 'system_agent' },
    }),
    0,
  )
})

runDatabaseTest('a busy Designer DM pends the brief instead of double-running the agent', async (t) => {
  const prisma = new PrismaClient()
  const team = await seed(prisma)
  t.after(async () => {
    await cleanup(prisma, team)
    await prisma.$disconnect()
  })

  // Bootstrap the home first, then occupy its run slot exactly as an open card
  // or a turn still thinking would.
  const { ensureGlobalAgentBootstrap } = await import('@nessie/team-admin')
  const home = await ensureGlobalAgentBootstrap(prisma, {
    blueprint: AGENT_DESIGNER_BLUEPRINT,
    organizationId: team.organizationId,
    teamId: team.teamId,
    userId: team.ownerId,
  })
  const busy = await prisma.run.create({
    data: { agentId: home.agentId, status: 'waiting_input', threadId: home.threadId },
  })

  await runAgentHandoffTool(buildContext(prisma, team), {
    brief: 'A second thing, while the first card is still open.',
    target: AGENT_DESIGNER_SLUG,
  })

  const runs = await prisma.run.findMany({
    where: { agentId: home.agentId, threadId: home.threadId },
    select: { id: true },
  })
  assert.deepEqual(runs.map((run) => run.id), [busy.id], 'no concurrent run may be created')
  assert.equal(
    await prisma.runThreadPendingMessage.count({
      where: { agentId: home.agentId, threadId: home.threadId },
    }),
    1,
    'the brief is recorded for the batched follow-up instead',
  )
  // The handoff itself still happened: the brief and its durable row exist.
  assert.equal(await prisma.message.count({ where: { threadId: home.threadId } }), 1)
  assert.equal(
    await prisma.agentHandoffRequest.count({
      where: { organizationId: team.organizationId },
    }),
    1,
  )
})
