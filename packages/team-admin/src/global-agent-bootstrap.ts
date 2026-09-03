import { Prisma, type PrismaClient } from '@prisma/client'
import { parseAgentId, parseChannelId, parseThreadId } from '@nessie/schemas'

import {
  acquireAgentToolPolicyLock,
  assertGenericAgentToolPolicyInput,
  mergeGenericAgentToolPolicy,
} from './agent-tool-policy-core.js'
import { ensureDefaultThread } from './channel-records.js'
import { loadChannelTeamProject } from './channel-slugs.js'
import {
  globalAgentHomeDmKey,
  listGlobalAgentBlueprints,
  resolveGlobalAgentModel,
  type GlobalAgentBlueprint,
} from './global-agent-blueprints.js'

/**
 * Turning a global-agent blueprint into rows: one system-managed `Agent` per
 * organisation plus one private home DM per person.
 *
 * This is `ensurePersonalAssistantAgent` with the discriminator fixed: advisory
 * lock → find by `(organizationId, systemSlug)` → create or update in place,
 * with the tool policy merged under the per-agent policy lock after re-reading
 * the row, so a targeted grant committed between the org-level lookup and the
 * write is never clobbered.
 *
 * The agent tuple is `(systemManaged, shared, dm_only, act_as_requesting_user)`
 * — the fourth combination `agents_system_managed_invariants_chk` already
 * sanctions (migration 20260902170000). No new CHECK is added for it.
 */

const GLOBAL_AGENT_KIND = 'shared' as const
const GLOBAL_AGENT_CHANNEL_TYPE = 'system_agent' as const
const GLOBAL_AGENT_DELEGATION_MODE = 'act_as_requesting_user' as const
// A global agent is bindable to ordinary channels (`isChannelBindableAgent`),
// so the row must not claim `dm_only` — that is the storage-level statement
// "this agent lives only in a per-user private DM", which is the Personal
// Assistant's and an external product's shape, not this one. `delegationMode`
// stays `act_as_requesting_user` and means exactly what it always did: the
// surface condition (`isGlobalAgentHomeSurface`) is what decides where that
// delegation is exercised, and a shared room is not it.
const GLOBAL_AGENT_SURFACE_POLICY = 'shared' as const
const GLOBAL_AGENT_SYSTEM_TEAM_NAME = 'Global Agent System'

export type GlobalAgentBootstrapInput = {
  blueprint: GlobalAgentBlueprint
  organizationId: string
  teamId: string
  userId: string
}

export type GlobalAgentBootstrapResult = {
  agentId: string
  channelId: string
  threadId: string
}

export const ensureGlobalAgentSystemTeam = async (
  prisma: PrismaClient,
  input: { organizationId: string; teamId: string },
): Promise<string> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${input.organizationId}),
        hashtext('global_agent_system_team')
      )
    `

    const existing = await tx.team.findFirst({
      where: {
        name: GLOBAL_AGENT_SYSTEM_TEAM_NAME,
        project: { organizationId: input.organizationId },
        systemManaged: true,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })
    if (existing) {
      return existing.id
    }

    const seedTeam = await tx.team.findFirst({
      where: {
        id: input.teamId,
        project: { organizationId: input.organizationId },
      },
      select: { projectId: true },
    })
    if (!seedTeam) {
      throw new Error('GLOBAL_AGENT_SYSTEM_TEAM_CONTEXT_NOT_FOUND')
    }

    const team = await tx.team.create({
      data: {
        name: GLOBAL_AGENT_SYSTEM_TEAM_NAME,
        projectId: seedTeam.projectId,
        systemManaged: true,
      },
      select: { id: true },
    })

    return team.id
  })

const buildGlobalAgentData = (
  organizationId: string,
  blueprint: GlobalAgentBlueprint,
  toolPolicy: Record<string, boolean>,
): Prisma.AgentUncheckedCreateInput => {
  const { model, provider } = resolveGlobalAgentModel(blueprint)
  return {
    agentKind: GLOBAL_AGENT_KIND,
    delegationMode: GLOBAL_AGENT_DELEGATION_MODE,
    effort: blueprint.effort,
    model,
    name: blueprint.name,
    organizationId,
    provider,
    role: blueprint.role,
    surfacePolicy: GLOBAL_AGENT_SURFACE_POLICY,
    systemManaged: true,
    systemSlug: blueprint.slug,
    systemPrompt: blueprint.buildSystemPrompt({ organizationId }),
    toolPolicy,
    ...(blueprint.runLimits ? { runLimits: blueprint.runLimits } : {}),
  }
}

export const ensureGlobalAgent = async (
  prisma: PrismaClient,
  blueprint: GlobalAgentBlueprint,
  organizationId: string,
): Promise<string> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${organizationId}),
        hashtext(${`global_agent:${blueprint.slug}`})
      )
    `

    const existing = await tx.agent.findFirst({
      where: { organizationId, systemSlug: blueprint.slug },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })

    if (existing) {
      await acquireAgentToolPolicyLock(tx, existing.id)
      // Re-read under the shared per-agent policy lock: a targeted grant may
      // have committed after the org-level bootstrap lookup above.
      const current = await tx.agent.findUniqueOrThrow({
        where: { id: existing.id },
        select: { avatarBackgroundColor: true, id: true, toolPolicy: true },
      })
      const toolPolicy = await mergeGenericAgentToolPolicy(
        tx,
        current.toolPolicy,
        blueprint.toolPolicy,
      )
      const agent = await tx.agent.update({
        where: { id: existing.id },
        data: {
          ...buildGlobalAgentData(organizationId, blueprint, toolPolicy),
          // Never overwrite a colour already chosen for a generated portrait;
          // the blueprint value is only ever a first value.
          ...(current.avatarBackgroundColor === null && blueprint.avatarBackgroundColor
            ? { avatarBackgroundColor: blueprint.avatarBackgroundColor }
            : {}),
        },
        select: { id: true },
      })
      return parseAgentId(agent.id)
    }

    // Vendor config passes the same protected-key gate as user input: a
    // blueprint cannot smuggle an explicit-grant key either.
    await assertGenericAgentToolPolicyInput(tx, blueprint.toolPolicy)
    const agent = await tx.agent.create({
      data: {
        ...buildGlobalAgentData(organizationId, blueprint, blueprint.toolPolicy),
        ...(blueprint.avatarBackgroundColor
          ? { avatarBackgroundColor: blueprint.avatarBackgroundColor }
          : {}),
      },
      select: { id: true },
    })
    return parseAgentId(agent.id)
  })

/**
 * The per-user home DM. Membership is forcibly reduced to the one encoded user
 * inside a single transaction: the deferred `channel_members` trigger checks at
 * commit, so the upsert and the removal of stale members must share one.
 */
export const ensureGlobalAgentChannel = async (
  prisma: PrismaClient,
  input: {
    blueprint: GlobalAgentBlueprint
    organizationId: string
    teamId: string
    userId: string
  },
): Promise<string> => {
  const dmKey = globalAgentHomeDmKey({
    organizationId: input.organizationId,
    slug: input.blueprint.slug,
    userId: input.userId,
  })
  const teamProject = await loadChannelTeamProject(prisma, {
    organizationId: input.organizationId,
    teamId: input.teamId,
  })
  if (!teamProject) {
    throw new Error('GLOBAL_AGENT_TEAM_NOT_IN_ORGANIZATION')
  }

  const channelData = {
    // Bootstrap repairs its own DM: a historical archive would otherwise hide
    // the one doorway a person has to this agent.
    archivedAt: null,
    label: input.blueprint.name,
    organizationId: input.organizationId,
    projectId: teamProject.projectId,
    systemChannelType: GLOBAL_AGENT_CHANNEL_TYPE,
    teamId: input.teamId,
    type: 'dm' as const,
    visibility: 'private' as const,
  }

  const reduceToSoleMember = async (
    tx: Prisma.TransactionClient,
    channelId: string,
  ): Promise<void> => {
    await tx.channelMember.upsert({
      where: { channelId_userId: { channelId, userId: input.userId } },
      create: { channelId, userId: input.userId, role: 'owner' },
      update: { role: 'owner' },
    })
    await tx.channelMember.deleteMany({
      where: { channelId, userId: { not: input.userId } },
    })
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const channel = await tx.channel.upsert({
        where: { dmKey },
        create: {
          ...channelData,
          dmKey,
          members: { create: { userId: input.userId, role: 'owner' } },
        },
        update: channelData,
        select: { id: true },
      })
      await reduceToSoleMember(tx, channel.id)
      return parseChannelId(channel.id)
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const fallback = await prisma.channel.findUnique({
        where: { dmKey },
        select: { id: true },
      })
      if (!fallback) {
        throw error
      }
      return await prisma.$transaction(async (tx) => {
        await tx.channel.update({ where: { id: fallback.id }, data: channelData })
        await reduceToSoleMember(tx, fallback.id)
        return parseChannelId(fallback.id)
      })
    }
    throw error
  }
}

/**
 * The home binding is written directly, not through `bindAgentToChannel` — the
 * same sanctioned bootstrap bypass `ensurePersonalAssistantBinding` and the
 * private-agent home use. That chokepoint refuses every system channel, which
 * is exactly the rule that keeps a *second* agent out of this DM.
 */
export const ensureGlobalAgentBinding = async (
  prisma: PrismaClient,
  input: { agentId: string; channelId: string },
): Promise<void> => {
  await prisma.agentBinding.createMany({
    data: [{ agentId: input.agentId, channelId: input.channelId }],
    skipDuplicates: true,
  })
}

export const ensureGlobalAgentBootstrap = async (
  prisma: PrismaClient,
  input: GlobalAgentBootstrapInput,
): Promise<GlobalAgentBootstrapResult> => {
  const systemTeamId = await ensureGlobalAgentSystemTeam(prisma, {
    organizationId: input.organizationId,
    teamId: input.teamId,
  })
  const agentId = await ensureGlobalAgent(prisma, input.blueprint, input.organizationId)
  const channelId = await ensureGlobalAgentChannel(prisma, {
    blueprint: input.blueprint,
    organizationId: input.organizationId,
    teamId: systemTeamId,
    userId: input.userId,
  })
  const threadId = await ensureDefaultThread(prisma, channelId)
  await ensureGlobalAgentBinding(prisma, { agentId, channelId })

  return { agentId, channelId, threadId: parseThreadId(threadId) }
}

/**
 * Every registered global agent, ensured for one organisation and one person.
 * Idempotent and cheap enough to run wherever the Personal Assistant's own
 * bootstrap runs (login, provisioning) — the sidebar DM row is a discovery
 * surface and should simply be there.
 */
export const ensureGlobalAgentsForUser = async (
  prisma: PrismaClient,
  input: { organizationId: string; teamId: string; userId: string },
): Promise<GlobalAgentBootstrapResult[]> => {
  const results: GlobalAgentBootstrapResult[] = []
  for (const blueprint of listGlobalAgentBlueprints()) {
    results.push(await ensureGlobalAgentBootstrap(prisma, { ...input, blueprint }))
  }
  return results
}
