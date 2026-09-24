import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import { PERSON_MESSAGE_AUTHORSHIP } from '@nessie/schemas'
import { AGENT_DESIGNER_BLUEPRINT, ensureGlobalAgentBootstrap } from '@nessie/team-admin'

import { createConsumedSourceSink } from '../../src/run/execute/disclosure-basis.js'
import type { BuiltinToolRuntimeContext } from '../../src/run/tool-types.js'

/**
 * The world the project-operator suites run in: a CTO bound to #eng of
 * project Nessie with the `project_operator` grant, an owner, a member of the
 * project and an organisation member outside it, a second project the CTO
 * also sits in and an agent that works only there, and the rooms the arm must
 * stay shut in — a room of Nessie the CTO is not in, and an organisation-wide
 * channel and a DM it is bound to, beside a system conversation (the Agent
 * Designer's home DM, where no agent may be bound).
 *
 * Every context names a real run and the real messages its turn answers,
 * because the arm opens only on the person's own composer message
 * (`isPersonsOwnTurn`).
 */
export const seedProjectOperatorWorld = async (prisma: PrismaClient) => {
  const suffix = randomUUID()
  const user = (name: string) =>
    prisma.user.create({ data: { displayName: name, email: `op-${name.toLowerCase()}-${suffix}@example.test` } })
  const [owner, member, outsider] = [await user('Owner'), await user('Member'), await user('Outsider')]
  const organization = await prisma.organization.create({ data: { name: `project-operator-${suffix}` } })
  // The default rule every organisation is seeded with (`seedDefaultPolicies`):
  // anyone may create a knowledge space, subject to the project gate.
  await prisma.policyRule.create({
    data: {
      action: 'create',
      bindings: { create: { actorId: '*', actorType: 'role' } },
      createdBy: owner.id,
      effect: 'allow',
      organizationId: organization.id,
      priority: 100,
      resourceType: 'knowledge_space',
      scope: 'organization',
      scopeId: organization.id,
      seedKey: 'default:knowledge_space:create:allow:*',
    },
  })
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: organization.id, role: 'owner', userId: owner.id },
      { organizationId: organization.id, role: 'member', userId: member.id },
      { organizationId: organization.id, role: 'member', userId: outsider.id },
    ],
  })
  const project = await prisma.project.create({ data: { name: 'Nessie', organizationId: organization.id } })
  const other = await prisma.project.create({ data: { name: 'Other', organizationId: organization.id } })
  const root = await prisma.project.create({
    data: { channelRoot: true, name: `root-${suffix}`, organizationId: organization.id },
  })
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, role: 'owner', userId: owner.id },
      { projectId: project.id, role: 'member', userId: member.id },
      { projectId: other.id, role: 'owner', userId: owner.id },
    ],
  })
  const team = await prisma.team.create({ data: { name: `team-${suffix}`, projectId: project.id } })
  const otherTeam = await prisma.team.create({ data: { name: `other-team-${suffix}`, projectId: other.id } })
  const rootTeam = await prisma.team.create({ data: { name: `root-team-${suffix}`, projectId: root.id } })
  await prisma.teamMember.createMany({
    data: [
      { role: 'owner', teamId: team.id, userId: owner.id },
      { role: 'member', teamId: team.id, userId: member.id },
      { role: 'owner', teamId: otherTeam.id, userId: owner.id },
    ],
  })
  const board = await prisma.board.create({
    data: { isDefault: true, name: 'Engineering', organizationId: organization.id, position: 0, projectId: project.id },
  })
  for (const [position, [name, category]] of ([
    ['Backlog', 'todo'], ['In progress', 'in_progress'], ['Review', 'review'], ['Done', 'done'],
  ] as const).entries()) {
    await prisma.boardColumn.create({
      data: { boardId: board.id, category, name, organizationId: organization.id, position },
    })
  }
  const channel = (
    home: { projectId: string; teamId: string },
    label: string,
    extra: Record<string, unknown> = {},
  ) => prisma.channel.create({
    data: {
      label, organizationId: organization.id, projectId: home.projectId, slug: `${label}-${suffix}`,
      teamId: home.teamId, visibility: 'public', ...extra,
    },
    select: { id: true },
  })
  const nessie = { projectId: project.id, teamId: team.id }
  const eng = await channel(nessie, 'eng')
  const unbound = await channel(nessie, 'design')
  const elsewhere = await channel({ projectId: other.id, teamId: otherTeam.id }, 'elsewhere')
  const orgWide = await channel({ projectId: root.id, teamId: rootTeam.id }, 'everyone')
  const dm = await channel(nessie, 'dm', { dmKey: `dm:${owner.id}:${suffix}`, type: 'dm', visibility: 'private' })
  // A system conversation: the Agent Designer's real home DM for the owner.
  const system = { id: (await ensureGlobalAgentBootstrap(prisma, {
    blueprint: AGENT_DESIGNER_BLUEPRINT, organizationId: organization.id, teamId: team.id, userId: owner.id,
  })).channelId }
  const agent = (name: string, toolPolicy: Record<string, boolean>) =>
    prisma.agent.create({
      data: { name, organizationId: organization.id, projectId: project.id, toolPolicy, visibility: 'team' },
      select: { id: true },
    })
  const cto = await agent('CTO', { project_operator: true })
  // Another team agent, working only in the other project.
  const scout = await agent('Scout', {})
  await prisma.agentBinding.createMany({
    data: [
      ...[eng, elsewhere, orgWide, dm].map(({ id }) => ({ agentId: cto.id, channelId: id })),
      { agentId: scout.id, channelId: elsewhere.id },
    ],
  })
  return {
    boardId: board.id,
    ctoId: cto.id,
    dmId: dm.id,
    elsewhereId: elsewhere.id,
    engId: eng.id,
    memberId: member.id,
    organizationId: organization.id,
    orgWideId: orgWide.id,
    otherProjectId: other.id,
    outsiderId: outsider.id,
    ownerId: owner.id,
    projectId: project.id,
    rootProjectId: root.id,
    scoutId: scout.id,
    systemId: system.id,
    teamId: team.id,
    unboundId: unbound.id,
    cleanup: async () => {
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: [owner.id, member.id, outsider.id] } } })
    },
  }
}
export type ProjectOperatorWorld = Awaited<ReturnType<typeof seedProjectOperatorWorld>>

/** A message in a thread: a person's composer message unless told otherwise. */
export const postMessage = (
  prisma: PrismaClient,
  threadId: string,
  input: { authoredByPerson?: boolean; role?: 'assistant' | 'system' | 'user'; userId: string | null },
) => prisma.message.create({
  data: {
    content: 'Set up project Mobile for me, please.',
    metadata: input.authoredByPerson === false ? {} : { authorship: PERSON_MESSAGE_AUTHORSHIP },
    role: input.role ?? 'user',
    threadId,
    userId: input.userId,
  },
  select: { id: true },
})

export type TurnShape = {
  actorType?: 'agent' | 'user'
  /** Other messages a drain folded in beside the trigger. */
  batch?: readonly string[]
  channelId?: string
  continuationOf?: boolean
  effectiveUserId?: string
  interactive?: boolean
  /** The trigger message; a person's own composer message by the actor when omitted. */
  messageId?: string
  purpose?: string
  restartOf?: boolean
  resumedByUserId?: string
  threadId?: string
}

/**
 * A run of the CTO answering `actingUserId`: a real thread, trigger message
 * and run row — a first turn, or the Continue, card answer, Restart or drain
 * the shape names.
 */
export const operatorContext = async (
  prisma: PrismaClient,
  s: ProjectOperatorWorld,
  actingUserId: string,
  shape: TurnShape = {},
): Promise<BuiltinToolRuntimeContext> => {
  const channelId = shape.channelId ?? s.engId
  const threadId = shape.threadId ?? (await prisma.thread.create({ data: { channelId }, select: { id: true } })).id
  const messageId = shape.messageId
    ?? (await postMessage(prisma, threadId, { userId: actingUserId })).id
  const predecessor = shape.continuationOf || shape.restartOf
    ? (await prisma.run.create({
        data: { agentId: s.ctoId, status: 'completed', threadId, triggerMessageId: messageId },
        select: { id: true },
      })).id
    : null
  const run = await prisma.run.create({
    data: {
      agentId: s.ctoId,
      status: 'completed',
      threadId,
      triggerMessageId: messageId,
      ...(shape.continuationOf ? { continuationOfRunId: predecessor } : {}),
      ...(shape.restartOf ? { restartOfRunId: predecessor } : {}),
    },
    select: { id: true },
  })
  const channelRow = await prisma.channel.findUniqueOrThrow({
    where: { id: channelId },
    select: { projectId: true, systemChannelType: true },
  })
  return {
    actorContext: {
      actionContext: {
        requestId: `project-operator-${randomUUID()}`,
        teamId: s.teamId,
        ...(shape.effectiveUserId ? { effectiveUserId: shape.effectiveUserId } : {}),
        ...(shape.purpose ? { purpose: shape.purpose } : {}),
      },
      actor: {
        actorId: shape.actorType === 'agent' ? s.ctoId : actingUserId,
        actorType: shape.actorType ?? 'user',
        roles: ['member'],
      },
      tenant: { organizationId: s.organizationId, projectId: s.projectId, teamId: s.teamId },
    },
    agentId: s.ctoId,
    agentKind: 'shared',
    channel: {
      id: channelId,
      organizationId: s.organizationId,
      projectId: channelRow.projectId,
      systemChannelType: channelRow.systemChannelType,
    },
    consumedSources: createConsumedSourceSink(),
    ledgerIdentity: null,
    prisma,
    realtimeTransport: { publishWs: async () => {} } as unknown as BuiltinToolRuntimeContext['realtimeTransport'],
    run: {
      id: run.id,
      interactive: shape.interactive ?? true,
      messageId,
      threadId,
      ...(shape.batch ? { batchMessageIds: [...shape.batch, messageId] } : {}),
      ...(shape.resumedByUserId ? { resumedByUserId: shape.resumedByUserId } : {}),
    },
    // What a real run carries: the CTO's own row, which is no global agent.
    runContext: { agent: { systemSlug: null } } as unknown as BuiltinToolRuntimeContext['runContext'],
    toolCallId: randomUUID(),
  } as unknown as BuiltinToolRuntimeContext
}

export const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the tool to refuse')
}

/** Refused for the room: the grant, the room, the binding or the switch. */
export const ARM_REFUSAL = /works only in a project channel you are in/
/** Refused for the turn: nobody asking now, or somebody else's input. */
export const LIVE_TURN_REFUSAL = /works only on their own turn, from a message they sent you themselves/
