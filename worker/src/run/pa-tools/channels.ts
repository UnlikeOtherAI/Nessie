import type { ChannelRecord } from '@nessie/schemas'
import {
  ChannelSlugConflictError,
  ChannelValidationError,
  setChannelArchived,
  updateChannel,
} from '@nessie/team-admin'

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
import { recordChannelDirectoryRead } from './message-search-basis.js'
import { clampLimit, formatChannelRef, formatSection, truncate } from './tool-output.js'

// The shared writes answer with the flat channel record; the assistant's
// formatters read the nested channel/team shape.
const toChannelRef = (channel: ChannelRecord) => ({
  label: channel.label,
  slug: channel.slug,
  team: { name: channel.teamName, project: { name: channel.projectName } },
})

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

  // Provenance: the non-public channels among these were reachable only through
  // the acting person's own memberships.
  recordChannelDirectoryRead(context, channels)

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

  // Same obligation as `channel_list`: a match found through the person's own
  // membership in a non-public channel is scoped material.
  recordChannelDirectoryRead(context, channels)

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

  let channel: ChannelRecord | null
  try {
    channel = await updateChannel(context.prisma, {
      channelId: input.channelId,
      organizationId,
      userId,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.topic !== undefined ? { topic: input.topic } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
  } catch (error) {
    // The shared write states the rule; the assistant says it as a sentence.
    if (error instanceof ChannelValidationError || error instanceof ChannelSlugConflictError) {
      throw new Error(`${error.message}.`)
    }
    throw error
  }
  if (!channel) {
    throw new Error('Channel not found or insufficient permissions to manage it.')
  }

  const channelRef = toChannelRef(channel)
  return {
    inputSummary: `channelId=${input.channelId}`,
    outputPreview: [
      `Updated channelId=${channel.id}`,
      `channel=${formatChannelRef(channelRef)}`,
      `slug=${getScopedChannelSlug(channelRef)}`,
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
  let channel: ChannelRecord | null
  try {
    channel = await setChannelArchived(context.prisma, {
      archived,
      channelId: input.channelId,
      organizationId,
      userId,
    })
  } catch (error) {
    // Unarchiving can collide: an archived channel does not hold its name.
    if (error instanceof ChannelSlugConflictError) {
      throw new Error(`${error.message}.`)
    }
    throw error
  }
  if (!channel) {
    throw new Error('Channel not found or insufficient permissions to manage it.')
  }

  return {
    inputSummary: `channelId=${input.channelId} archived=${archived}`,
    outputPreview:
      `${channel.archivedAt ? 'Archived' : 'Unarchived'} channelId=${channel.id} | ${formatChannelRef(toChannelRef(channel))}`,
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
