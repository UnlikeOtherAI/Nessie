import { Prisma, type PrismaClient } from '@prisma/client'
import {
  getScopedChannelSlug,
  parseScopedChannelTarget,
  toChannelSlug,
} from '../channel-slugs.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import {
  buildVisibleChannelWhere,
  requireActingUserId,
} from './access.js'
import { clampLimit, formatChannelRef, formatSection, truncate } from './tool-output.js'

// Channel-manage authz mirrored from api/src/services/channels.ts canManageChannel:
// channel owner/admin, org owner/admin, or team owner/admin may manage.
const canManageChannel = async (
  prisma: PrismaClient,
  input: { userId: string; organizationId: string; channelId: string },
): Promise<boolean> => {
  const channel = await prisma.channel.findUnique({
    where: { id: input.channelId },
    select: { organizationId: true, teamId: true },
  })
  if (!channel || channel.organizationId !== input.organizationId) {
    return false
  }

  const [channelMember, orgMember, teamMember] = await Promise.all([
    prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
      select: { role: true },
    }),
    prisma.organizationMember.findFirst({
      where: { organizationId: input.organizationId, userId: input.userId },
      select: { role: true },
    }),
    prisma.teamMember.findFirst({
      where: { teamId: channel.teamId, userId: input.userId },
      select: { role: true },
    }),
  ])

  return (
    channelMember?.role === 'owner'
    || channelMember?.role === 'admin'
    || orgMember?.role === 'owner'
    || orgMember?.role === 'admin'
    || teamMember?.role === 'owner'
    || teamMember?.role === 'admin'
  )
}

const ensureChannelSlugAvailable = async (
  prisma: PrismaClient,
  input: { channelId: string; projectId: string; slug: string },
): Promise<void> => {
  const existing = await prisma.channel.findFirst({
    where: {
      id: { not: input.channelId },
      projectId: input.projectId,
      slug: input.slug,
      type: 'standard',
    },
    select: { id: true },
  })
  if (existing) {
    throw new Error(`A channel with slug "${input.slug}" already exists in this project.`)
  }
}

const isChannelSlugConflict = (error: unknown): boolean => {
  const target = error instanceof Prisma.PrismaClientKnownRequestError
    ? error.meta?.['target']
    : undefined
  return (
    error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === 'P2002'
    && (
      target === 'channels_project_slug_standard_key'
      || (Array.isArray(target) && target.includes('channels_project_slug_standard_key'))
      || (Array.isArray(target) && target.includes('project_id') && target.includes('slug'))
    )
  )
}

export const runChannelListTool = async (
  context: BuiltinToolRuntimeContext,
  input: { includeArchived?: boolean; limit?: unknown },
): Promise<ToolExecutionResult> => {
  const userId = requireActingUserId(context)
  const organizationId = context.channel.organizationId
  const take = clampLimit(input.limit, 20)

  const channels = await context.prisma.channel.findMany({
    where: {
      ...buildVisibleChannelWhere(organizationId, userId),
      ...(input.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      label: true,
      slug: true,
      visibility: true,
      topic: true,
      archivedAt: true,
      team: {
        select: {
          name: true,
          project: { select: { name: true } },
        },
      },
    },
    take,
  })

  const lines = channels.map((channel, index) =>
    `${index + 1}. ${formatChannelRef(channel)} | channelId=${channel.id} | visibility=${channel.visibility}`
    + ` | slug=${getScopedChannelSlug(channel)}`
    + ` | archived=${channel.archivedAt ? 'yes' : 'no'}`
    + (channel.topic ? ` | topic="${channel.topic}"` : ''),
  )

  return {
    inputSummary: `includeArchived=${Boolean(input.includeArchived)}`,
    outputPreview:
      formatSection(`Channels (${lines.length})`, lines) || 'No channels visible.',
    toolName: 'channel_list',
  }
}

export const runChannelFindTool = async (
  context: BuiltinToolRuntimeContext,
  input: { query: string; limit?: unknown },
): Promise<ToolExecutionResult> => {
  const userId = requireActingUserId(context)
  const organizationId = context.channel.organizationId
  const query = input.query.trim().replace(/^#/, '')
  if (!query) {
    throw new Error('query is required.')
  }
  const take = clampLimit(input.limit, 10)
  const scopedTarget = parseScopedChannelTarget(query)
  const querySlug = scopedTarget?.channelSlug ?? toChannelSlug(query)

  const channels = (await context.prisma.channel.findMany({
    where: {
      ...buildVisibleChannelWhere(organizationId, userId),
      archivedAt: null,
      OR: [
        { label: { contains: query, mode: 'insensitive' } },
        ...(querySlug ? [{ slug: { contains: querySlug, mode: 'insensitive' as const } }] : []),
      ],
    },
    orderBy: { label: 'asc' },
    select: {
      id: true,
      label: true,
      slug: true,
      visibility: true,
      team: {
        select: {
          name: true,
          project: { select: { name: true } },
        },
      },
    },
    take,
  })).filter(
    (channel) =>
      !scopedTarget
      || toChannelSlug(channel.team?.project.name ?? '') === scopedTarget.projectSlug,
  )

  const lines = channels.map(
    (channel) =>
      `${formatChannelRef(channel)} | channelId=${channel.id} | slug=${getScopedChannelSlug(channel)} | visibility=${channel.visibility}`,
  )

  return {
    inputSummary: `query="${query}"`,
    outputPreview:
      formatSection(`Matches (${lines.length})`, lines) ||
      `No channels matched "${query}".`,
    toolName: 'channel_find',
  }
}

export const runChannelUpdateTool = async (
  context: BuiltinToolRuntimeContext,
  input: {
    channelId: string
    label?: string
    topic?: string
    description?: string
  },
): Promise<ToolExecutionResult> => {
  const userId = requireActingUserId(context)
  const organizationId = context.channel.organizationId
  if (!input.channelId) {
    throw new Error('channelId is required.')
  }
  if (
    input.label === undefined
    && input.topic === undefined
    && input.description === undefined
  ) {
    throw new Error('Provide at least one of label, topic, or description.')
  }

  const canManage = await canManageChannel(context.prisma, {
    channelId: input.channelId,
    organizationId,
    userId,
  })
  if (!canManage) {
    throw new Error('Channel not found or insufficient permissions to manage it.')
  }

  const data: Prisma.ChannelUpdateInput = {}
  if (input.label !== undefined) {
    const label = input.label.trim()
    const slug = toChannelSlug(label)
    if (slug.length === 0) {
      throw new Error('Channel name must contain at least one letter or number.')
    }
    const channel = await context.prisma.channel.findUnique({
      where: { id: input.channelId },
      select: { projectId: true },
    })
    if (!channel) {
      throw new Error('Channel not found.')
    }
    await ensureChannelSlugAvailable(context.prisma, {
      channelId: input.channelId,
      projectId: channel.projectId,
      slug,
    })
    data.label = label
    data.slug = slug
  }
  if (input.topic !== undefined) {
    data.topic = input.topic
  }
  if (input.description !== undefined) {
    data.description = input.description
  }

  let channel
  try {
    channel = await context.prisma.channel.update({
      where: { id: input.channelId },
      data,
      select: {
        id: true,
        label: true,
        slug: true,
        topic: true,
        description: true,
        team: {
          select: {
            name: true,
            project: { select: { name: true } },
          },
        },
      },
    })
  } catch (error) {
    if (isChannelSlugConflict(error) && input.label !== undefined) {
      throw new Error(`A channel with slug "${toChannelSlug(input.label)}" already exists in this project.`)
    }
    throw error
  }

  return {
    inputSummary: `channelId=${input.channelId}`,
    outputPreview: [
      `Updated channelId=${channel.id}`,
      `channel=${formatChannelRef(channel)}`,
      `slug=${getScopedChannelSlug(channel)}`,
      `topic=${channel.topic ? `"${channel.topic}"` : '(none)'}`,
      `description=${channel.description ? `"${truncate(channel.description, 120)}"` : '(none)'}`,
    ].join('\n'),
    toolName: 'channel_update',
  }
}

export const runChannelArchiveTool = async (
  context: BuiltinToolRuntimeContext,
  input: { channelId: string; archived?: boolean },
): Promise<ToolExecutionResult> => {
  const userId = requireActingUserId(context)
  const organizationId = context.channel.organizationId
  if (!input.channelId) {
    throw new Error('channelId is required.')
  }

  const archived = input.archived ?? true
  const canManage = await canManageChannel(context.prisma, {
    channelId: input.channelId,
    organizationId,
    userId,
  })
  if (!canManage) {
    throw new Error('Channel not found or insufficient permissions to manage it.')
  }

  const channel = await context.prisma.channel.update({
    where: { id: input.channelId },
    data: { archivedAt: archived ? new Date() : null },
    select: {
      id: true,
      label: true,
      archivedAt: true,
      team: {
        select: {
          name: true,
          project: { select: { name: true } },
        },
      },
    },
  })

  return {
    inputSummary: `channelId=${input.channelId} archived=${archived}`,
    outputPreview:
      `${channel.archivedAt ? 'Archived' : 'Unarchived'} channelId=${channel.id} | ${formatChannelRef(channel)}`,
    toolName: 'channel_archive',
  }
}

export const runChannelJoinTool = async (
  context: BuiltinToolRuntimeContext,
  input: { channelId: string },
): Promise<ToolExecutionResult> => {
  const userId = requireActingUserId(context)
  const organizationId = context.channel.organizationId
  if (!input.channelId) {
    throw new Error('channelId is required.')
  }

  const channel = await context.prisma.channel.findUnique({
    where: { id: input.channelId },
    select: {
      organizationId: true,
      label: true,
      visibility: true,
      archivedAt: true,
      team: {
        select: {
          name: true,
          project: { select: { name: true } },
        },
      },
    },
  })
  if (!channel || channel.organizationId !== organizationId) {
    throw new Error('Channel not found.')
  }
  if (channel.visibility !== 'public' || channel.archivedAt) {
    throw new Error('Only active public channels can be joined.')
  }

  const isOrgMember = await context.prisma.organizationMember.count({
    where: { organizationId, userId },
  })
  if (!isOrgMember) {
    throw new Error('You are not a member of this organization.')
  }

  await context.prisma.channelMember.upsert({
    where: { channelId_userId: { channelId: input.channelId, userId } },
    create: { channelId: input.channelId, userId },
    update: {},
  })

  return {
    inputSummary: `channelId=${input.channelId}`,
    outputPreview: `Joined channelId=${input.channelId} | ${formatChannelRef(channel)}`,
    toolName: 'channel_join',
  }
}
