import { ChannelDecisionPolicySchema, ChannelIdSchema, type ChannelRecord } from '@nessie/schemas'
import {
  ChannelDecisionPolicyError,
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
  resolveActingMember,
} from './access.js'
import { recordMessageChannelRead } from './message-search-basis.js'
import { requireConsumedSources, resolveToolPostBasis } from './tool-message-basis.js'
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
  input: { channelId?: string; includeArchived?: boolean; limit?: unknown },
): Promise<ToolExecutionResult> => {
  const userId = requireActingUserId(context)
  const organizationId = context.channel.organizationId
  const take = clampLimit(input.limit, 20)

  const channels = await context.prisma.channel.findMany({
    where: {
      ...buildVisibleChannelWhere(organizationId, userId),
      ...(input.channelId ? { id: ChannelIdSchema.parse(input.channelId) } : {}),
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
      decisionPolicy: true,
      agentBindings: { select: { agentId: true, principalUserId: true } },
      team: {
        select: {
          name: true,
          project: { select: { name: true } },
        },
      },
    },
    take,
  })

  // Listing channels reads no channel's content and feeds nothing
  // (message-search-basis.ts). One channel's decision policy is content: it is
  // what that room's members wrote for its agents, so that read stamps.
  if (input.channelId) recordMessageChannelRead(context, channels.slice(0, 1))

  const lines = channels.map((channel, index) =>
    `${index + 1}. ${formatChannelRef(channel)} | channelId=${channel.id} | visibility=${channel.visibility}`
    + ` | slug=${getScopedChannelSlug(channel)}`
    + ` | archived=${channel.archivedAt ? 'yes' : 'no'}`
    + (channel.topic ? ` | topic="${channel.topic}"` : ''),
  )

  return {
    inputSummary: `includeArchived=${Boolean(input.includeArchived)}`,
    outputPreview:
      (formatSection(`Channels (${lines.length})`, lines) || 'No channels visible.')
      + (input.channelId && channels[0] ? `\nDecision policy: ${JSON.stringify(
        ChannelDecisionPolicySchema.nullable().parse(channels[0].decisionPolicy ?? null),
      )}\nAgent participants: ${JSON.stringify(channels[0].agentBindings)}` : ''),
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
    // The visibility predicate is itself an `OR`; spreading it beside the
    // label/slug `OR` let the second key replace the first, and the finder then
    // named private channels the person had never joined. Both must hold.
    where: {
      AND: [
        buildVisibleChannelWhere(organizationId, userId),
        { archivedAt: null },
        {
          OR: [
            { label: { contains: query, mode: 'insensitive' } },
            ...(querySlug ? [{ slug: { contains: querySlug, mode: 'insensitive' as const } }] : []),
          ],
        },
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

  // A directory match, like `channel_list`'s rows, reads no channel's content.
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
    decisionPolicy?: unknown
  },
): Promise<ToolExecutionResult> => {
  const member = await resolveActingMember(context)
  const { userId, organizationId } = member
  if (!input.channelId) {
    throw new Error('channelId is required.')
  }
  if (
    input.label === undefined
    && input.topic === undefined
    && input.description === undefined
    && input.decisionPolicy === undefined
  ) {
    throw new Error('Provide at least one of label, topic, description, or decisionPolicy.')
  }

  // Policies are readable channel content and have no per-reader basis rows.
  // A PA holding restricted material may author one only where the complete
  // channel audience already has that material. Clearing a policy writes none.
  if (input.decisionPolicy !== undefined && input.decisionPolicy !== null) {
    requireConsumedSources(context)
    if ((await resolveToolPostBasis(context, input.channelId)).length > 0) {
      throw new Error('I cannot copy restricted information into this channel’s decision policy.')
    }
  }

  let channel: ChannelRecord | null
  try {
    channel = await updateChannel(context.prisma, {
      actorContext: member.actorContext,
      channelId: input.channelId,
      organizationId,
      userId,
      isOrganizationAdmin: member.isOrganizationAdmin,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.topic !== undefined ? { topic: input.topic } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.decisionPolicy !== undefined ? {
        decisionPolicy: ChannelDecisionPolicySchema.nullable().parse(input.decisionPolicy),
      } : {}),
    })
  } catch (error) {
    // The shared write states the rule; the assistant says it as a sentence.
    if (error instanceof ChannelValidationError
      || error instanceof ChannelSlugConflictError
      || error instanceof ChannelDecisionPolicyError) {
      throw new Error(`${error.message}.`)
    }
    throw error
  }
  if (!channel) {
    throw new Error('Channel not found or insufficient permissions to manage it.')
  }

  // The result echoes the channel's own directory fields, plus a policy only
  // when this call wrote it — nothing the run did not already hold.
  const channelRef = toChannelRef(channel)
  return {
    inputSummary: `channelId=${input.channelId}`,
    outputPreview: [
      `Updated channelId=${channel.id}`,
      `channel=${formatChannelRef(channelRef)}`,
      `slug=${getScopedChannelSlug(channelRef)}`,
      `topic=${channel.topic ? `"${channel.topic}"` : '(none)'}`,
      `description=${channel.description ? `"${truncate(channel.description, 120)}"` : '(none)'}`,
      ...(input.decisionPolicy !== undefined ? [
        `decisionPolicy=${JSON.stringify(channel.decisionPolicy ?? null)}`,
      ] : []),
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
