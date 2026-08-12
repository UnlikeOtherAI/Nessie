import { Prisma, type PrismaClient } from '@prisma/client'
import { parseAgentId, parseChannelId, parseThreadId } from '@nessie/schemas'
import { ensureDefaultThread, loadChannelTeamProject } from '@nessie/workspace-admin'

/**
 * External-agent conversation surface bootstrap.
 *
 * An external agent is a peer of the Personal Assistant whose turns are proxied
 * directly to an external product over MCP — Nessie runs no inference for it
 * (`Agent.executionMode = external_mcp`). This mirrors the PA channel pattern
 * (`personal-assistant.ts`): a per-user private DM channel + a system-managed
 * `Agent` row + the ordinary `Channel → Thread → Message` storage, so feed
 * rendering, notifications, search, and streaming work unchanged.
 *
 * Everything is keyed by product slug so a second external agent is a data
 * change (a new `EXTERNAL_AGENT_PRODUCTS` entry) rather than a code fork.
 */

const EXTERNAL_AGENT_AGENT_KIND = 'shared' as const
const EXTERNAL_AGENT_CHANNEL_TYPE = 'external_agent' as const
const EXTERNAL_AGENT_DELEGATION_MODE = 'act_as_requesting_user' as const
const EXTERNAL_AGENT_SURFACE_POLICY = 'dm_only' as const
const EXTERNAL_AGENT_EXECUTION_MODE = 'external_mcp' as const
const EXTERNAL_AGENT_SYSTEM_TEAM_NAME = 'External Agent System'

export type ExternalAgentProduct = {
  /** Product slug (matches `integrated_products.slug`). */
  slug: string
  /** Display name for the agent + channel. */
  name: string
}

export const EXTERNAL_AGENT_PRODUCTS: Record<string, ExternalAgentProduct> = {
  deepsignal: { slug: 'deepsignal', name: 'DeepSignal' },
}

export const getExternalAgentProduct = (slug: string): ExternalAgentProduct | null =>
  EXTERNAL_AGENT_PRODUCTS[slug] ?? null

export type ExternalAgentBootstrapInput = {
  organizationId: string
  product: ExternalAgentProduct
  teamId: string
  userId: string
  workspaceId: string
}

export type ExternalAgentBootstrapResult = {
  agentId: string
  channelId: string
  threadId: string
}

const ensureExternalAgentSystemTeam = async (
  prisma: PrismaClient,
  input: { organizationId: string; teamId: string },
): Promise<string> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${input.organizationId}),
        hashtext('external_agent_system_team')
      )
    `

    const existing = await tx.team.findFirst({
      where: {
        name: EXTERNAL_AGENT_SYSTEM_TEAM_NAME,
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
      throw new Error('EXTERNAL_AGENT_SYSTEM_TEAM_CONTEXT_NOT_FOUND')
    }

    const team = await tx.team.create({
      data: {
        name: EXTERNAL_AGENT_SYSTEM_TEAM_NAME,
        projectId: seedTeam.projectId,
        systemManaged: true,
      },
      select: { id: true },
    })

    return team.id
  })

const createExternalAgentData = (organizationId: string, product: ExternalAgentProduct) => ({
  agentKind: EXTERNAL_AGENT_AGENT_KIND,
  delegationMode: EXTERNAL_AGENT_DELEGATION_MODE,
  executionMode: EXTERNAL_AGENT_EXECUTION_MODE,
  name: product.name,
  organizationId,
  role: 'assistant',
  surfacePolicy: EXTERNAL_AGENT_SURFACE_POLICY,
  systemManaged: true,
})

export const ensureExternalAgent = async (
  prisma: PrismaClient,
  organizationId: string,
  product: ExternalAgentProduct,
): Promise<string> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${organizationId}),
        hashtext(${`external_agent:${product.slug}`})
      )
    `

    // Discriminator: a system-managed, external-mcp agent named for the product.
    // `agentKind` stays `shared` (this is not a PA), so it cannot be the key.
    const existing = await tx.agent.findFirst({
      where: {
        organizationId,
        systemManaged: true,
        executionMode: EXTERNAL_AGENT_EXECUTION_MODE,
        name: product.name,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })

    if (existing) {
      const agent = await tx.agent.update({
        where: { id: existing.id },
        data: createExternalAgentData(organizationId, product),
        select: { id: true },
      })
      return parseAgentId(agent.id)
    }

    const agent = await tx.agent.create({
      data: createExternalAgentData(organizationId, product),
      select: { id: true },
    })
    return parseAgentId(agent.id)
  })

export const externalAgentDmKey = (
  productSlug: string,
  organizationId: string,
  userId: string,
  workspaceId: string,
): string => `extagent:${productSlug}:${organizationId}:${userId}:${workspaceId}`

const setSoleMember = async (
  prisma: PrismaClient,
  channelId: string,
  userId: string,
): Promise<void> => {
  await prisma.channelMember.upsert({
    where: { channelId_userId: { channelId, userId } },
    create: { channelId, userId, role: 'owner' },
    update: { role: 'owner' },
  })
  await prisma.channelMember.deleteMany({
    where: { channelId, userId: { not: userId } },
  })
}

export const ensureExternalAgentChannel = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    product: ExternalAgentProduct
    teamId: string
    userId: string
    workspaceId: string
  },
): Promise<string> => {
  const dmKey = externalAgentDmKey(
    input.product.slug,
    input.organizationId,
    input.userId,
    input.workspaceId,
  )
  const legacyDmKey =
    `extagent:${input.product.slug}:${input.organizationId}:${input.userId}`
  await prisma.channel.updateMany({
    where: { dmKey: legacyDmKey, archivedAt: null },
    data: { archivedAt: new Date() },
  })
  const teamProject = await loadChannelTeamProject(prisma, {
    organizationId: input.organizationId,
    teamId: input.teamId,
  })
  if (!teamProject) {
    throw new Error('External agent team does not belong to this organization')
  }

  const channelData = {
    label: input.product.name,
    type: 'dm' as const,
    organizationId: input.organizationId,
    projectId: teamProject.projectId,
    teamId: input.teamId,
    visibility: 'private' as const,
    systemChannelType: EXTERNAL_AGENT_CHANNEL_TYPE,
  }

  try {
    const channel = await prisma.channel.upsert({
      where: { dmKey },
      create: {
        ...channelData,
        dmKey,
        members: { create: { userId: input.userId, role: 'owner' } },
      },
      update: channelData,
      select: { id: true },
    })

    await setSoleMember(prisma, channel.id, input.userId)
    return parseChannelId(channel.id)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const fallback = await prisma.channel.findUnique({
        where: { dmKey },
        select: { id: true },
      })
      if (!fallback) {
        throw error
      }
      await prisma.channel.update({ where: { id: fallback.id }, data: channelData })
      await setSoleMember(prisma, fallback.id, input.userId)
      return parseChannelId(fallback.id)
    }
    throw error
  }
}

export const ensureExternalAgentBinding = async (
  prisma: PrismaClient,
  input: { agentId: string; channelId: string },
): Promise<void> => {
  await prisma.agentBinding.upsert({
    where: { agentId_channelId: { agentId: input.agentId, channelId: input.channelId } },
    create: { agentId: input.agentId, channelId: input.channelId },
    update: {},
  })
}

export const ensureExternalAgentBootstrap = async (
  prisma: PrismaClient,
  input: ExternalAgentBootstrapInput,
): Promise<ExternalAgentBootstrapResult> => {
  const systemTeamId = await ensureExternalAgentSystemTeam(prisma, {
    organizationId: input.organizationId,
    teamId: input.teamId,
  })
  const agentId = await ensureExternalAgent(prisma, input.organizationId, input.product)
  const channelId = await ensureExternalAgentChannel(prisma, {
    organizationId: input.organizationId,
    product: input.product,
    teamId: systemTeamId,
    userId: input.userId,
    workspaceId: input.workspaceId,
  })
  const threadId = await ensureDefaultThread(prisma, channelId)
  await ensureExternalAgentBinding(prisma, { agentId, channelId })

  return { agentId, channelId, threadId: parseThreadId(threadId) }
}
