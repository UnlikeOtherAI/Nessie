import { Prisma } from '@prisma/client'
import { computeInitialScheduleRunAt } from '@nessie/runtime'
import type { AgentTriggerType } from '@nessie/schemas'
import {
  getChannelSlug,
  getScopedChannelSlug,
  parseScopedChannelTarget,
  toChannelSlug,
} from './channel-slugs.js'
import { isDelegatingPersonalAssistant } from './pa-tools.js'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from './tool-types.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_ACTIVE_SCHEDULES = 25

type ParsedSchedule = {
  config: Record<string, unknown>
  describe: string
  type: AgentTriggerType
}

const resolveEffectiveUserId = (
  context: BuiltinToolRuntimeContext,
): string | null =>
  context.actorContext.actionContext.effectiveUserId
  ?? (context.actorContext.actor.actorType === 'user'
    ? context.actorContext.actor.actorId
    : null)

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`schedule_task requires a non-empty "${field}".`)
  }
  return value.trim()
}

/**
 * Translate the tool's friendly schedule object into an AgentTrigger type +
 * config. Throws on malformed input so wrapTool surfaces a clear message.
 */
const parseSchedule = (raw: unknown): ParsedSchedule => {
  const schedule = asRecord(raw)
  const kind = schedule['kind']

  if (kind === 'once') {
    const at = requireString(schedule['at'], 'schedule.at')
    const parsed = new Date(at)
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('schedule.at must be a valid ISO 8601 date-time.')
    }
    if (parsed.getTime() <= Date.now()) {
      throw new Error('schedule.at must be in the future.')
    }
    return {
      config: { mode: 'once', at: parsed.toISOString() },
      describe: `once at ${parsed.toISOString()}`,
      type: 'scheduled',
    }
  }

  if (kind === 'recurring') {
    const cron = requireString(schedule['cron'], 'schedule.cron')
    // Default to UTC when the caller omits a timezone, so cadence is deterministic
    // rather than dependent on the server's local zone.
    const timezone =
      typeof schedule['timezone'] === 'string' && schedule['timezone'].trim().length > 0
        ? schedule['timezone'].trim()
        : 'UTC'
    return {
      config: { cron, timezone },
      describe: `cron "${cron}" (${timezone})`,
      type: 'scheduled',
    }
  }

  if (kind === 'interval') {
    const everyMinutes = schedule['every_minutes']
    if (
      typeof everyMinutes !== 'number' ||
      !Number.isInteger(everyMinutes) ||
      everyMinutes < 1
    ) {
      throw new Error('schedule.every_minutes must be a positive integer.')
    }
    return {
      config: { interval_minutes: everyMinutes },
      describe: `every ${everyMinutes} minute(s)`,
      type: 'interval',
    }
  }

  throw new Error('schedule.kind must be one of "once", "recurring", or "interval".')
}

const visibleChannelWhere = (
  organizationId: string,
  userId: string | null,
  orgWide: boolean,
): Prisma.ChannelWhereInput =>
  orgWide
    ? { organizationId }
    : userId
      ? {
          organizationId,
          OR: [{ visibility: 'public' }, { members: { some: { userId } } }],
        }
      : { organizationId, visibility: 'public' }

type ResolvedTarget = {
  channelId: string
  label: string
  threadId: string
}

type ChannelTargetRow = {
  id: string
  label: string
  slug: string | null
  team: {
    name: string
    project: { name: string }
  } | null
}

const formatChannelTarget = (channel: ChannelTargetRow): string =>
  `#${channel.label} (${channel.team?.project.name ?? 'Unknown project'} / ${channel.team?.name ?? 'Unknown team'})`
  + ` channelId=${channel.id} slug=${getScopedChannelSlug(channel)}`

const resolveNamedChannelTarget = async (
  context: BuiltinToolRuntimeContext,
  target: string,
  userId: string | null,
): Promise<ChannelTargetRow> => {
  const scopedTarget = parseScopedChannelTarget(target)
  const channelSlug = scopedTarget?.channelSlug ?? toChannelSlug(target.replace(/^#/, ''))
  const candidates = await context.prisma.channel.findMany({
    where: {
      AND: [
        visibleChannelWhere(
          context.channel.organizationId,
          userId,
          isDelegatingPersonalAssistant(context),
        ),
        { archivedAt: null },
        {
          OR: [
            { label: { equals: target.replace(/^#/, ''), mode: 'insensitive' } },
            { slug: channelSlug },
          ],
        },
      ],
    },
    select: {
      id: true,
      label: true,
      slug: true,
      team: {
        select: {
          name: true,
          project: { select: { name: true } },
        },
      },
    },
  })

  const matches = scopedTarget
    ? candidates.filter(
        (channel) =>
          getChannelSlug(channel) === scopedTarget.channelSlug
          && toChannelSlug(channel.team?.project.name ?? '') === scopedTarget.projectSlug,
      )
    : candidates

  if (matches.length === 1) {
    return matches[0]!
  }

  if (matches.length > 1) {
    throw new Error(
      `Channel "${target}" is ambiguous. Use channelId or a scoped slug:\n`
      + matches.map(formatChannelTarget).join('\n'),
    )
  }

  throw new Error(
    `Could not find a channel "${target}" you have access to. Use channel_find, then pass channelId or a scoped slug like project/general.`,
  )
}

/**
 * Resolve where the scheduled task should report. Defaults to the conversation
 * the tool was called in; otherwise looks up a channel by id or label that the
 * requesting user can see, and uses its default (oldest) thread.
 */
const resolveTarget = async (
  context: BuiltinToolRuntimeContext,
  targetArg: string | undefined,
  userId: string | null,
): Promise<ResolvedTarget> => {
  if (!targetArg || targetArg.trim().length === 0) {
    return {
      channelId: context.channel.id,
      label: 'this conversation',
      threadId: context.run.threadId,
    }
  }

  const target = targetArg.trim()
  const channel = UUID_PATTERN.test(target)
    ? await context.prisma.channel.findFirst({
        where: {
          AND: [
            visibleChannelWhere(
              context.channel.organizationId,
              userId,
              isDelegatingPersonalAssistant(context),
            ),
            { id: target },
          ],
        },
        select: { id: true, label: true },
      })
    : await resolveNamedChannelTarget(context, target, userId)

  if (!channel) {
    throw new Error(
      `Could not find a channel "${target}" you have access to. Use channel_find, then pass channelId or a scoped slug like project/general.`,
    )
  }

  const thread = await context.prisma.thread.findFirst({
    where: { channelId: channel.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (!thread) {
    throw new Error(`Channel "${channel.label}" has no thread to post into yet.`)
  }

  return { channelId: channel.id, label: `#${channel.label}`, threadId: thread.id }
}

export const runScheduleTaskTool = async (
  context: BuiltinToolRuntimeContext,
  input: {
    instructions?: unknown
    name?: unknown
    schedule?: unknown
    target?: unknown
  },
): Promise<ToolExecutionResult> => {
  const instructions = requireString(input.instructions, 'instructions')
  const parsed = parseSchedule(input.schedule)
  const userId = resolveEffectiveUserId(context)
  const name =
    typeof input.name === 'string' && input.name.trim().length > 0
      ? input.name.trim()
      : undefined
  const targetArg = typeof input.target === 'string' ? input.target : undefined

  const target = await resolveTarget(context, targetArg, userId)

  // Posting into a channel other than the current one requires the agent to be a
  // member there, mirroring the binding check the scheduler enforces at fire time.
  // The personal assistant is exempt: it is its owner's delegate and reaches
  // every channel in the organization, so binding does not apply to it.
  if (
    target.channelId !== context.channel.id
    && !isDelegatingPersonalAssistant(context)
  ) {
    const binding = await context.prisma.agentBinding.findFirst({
      where: { agentId: context.agentId, channelId: target.channelId },
      select: { id: true },
    })
    if (!binding) {
      throw new Error(
        `I'm not a member of ${target.label}, so I can't post there. Add me to that channel first.`,
      )
    }
  }

  // Guard against runaway creation: a single misled/looping run could otherwise
  // create unbounded schedules (each a recurring agent run). Cap active ones.
  const activeCount = await context.prisma.agentTrigger.count({
    where: { ...buildOwnedScheduleWhere(context, userId), enabled: true },
  })
  if (activeCount >= MAX_ACTIVE_SCHEDULES) {
    throw new Error(
      `You already have ${activeCount} active scheduled tasks (limit ${MAX_ACTIVE_SCHEDULES}). ` +
        'Cancel one before scheduling another.',
    )
  }

  const config: Record<string, unknown> = {
    ...parsed.config,
    prompt: instructions,
    createdViaTool: true,
    ...(userId ? { createdByUserId: userId } : {}),
  }

  const nextRunAt = computeInitialScheduleRunAt({
    config,
    now: new Date(),
    type: parsed.type,
  })
  if (!nextRunAt) {
    throw new Error('The schedule was invalid (check the cron expression or interval).')
  }

  const trigger = await context.prisma.agentTrigger.create({
    data: {
      agentId: context.agentId,
      config: config as Prisma.InputJsonValue,
      enabled: true,
      name,
      nextRunAt,
      status: 'active',
      targetChannelId: target.channelId,
      targetThreadId: target.threadId,
      type: parsed.type,
    },
    select: { id: true },
  })

  return {
    inputSummary: name ?? instructions.slice(0, 80),
    outputPreview:
      `Scheduled task ${name ? `"${name}" ` : ''}created (id ${trigger.id}). ` +
      `Runs ${parsed.describe}, reporting into ${target.label}. ` +
      `Next run: ${nextRunAt.toISOString()}.`,
    toolName: 'schedule_task',
  }
}

type ScheduleFilter = {
  agentId: string
  AND: Prisma.AgentTriggerWhereInput[]
}

const buildOwnedScheduleWhere = (
  context: BuiltinToolRuntimeContext,
  userId: string | null,
): ScheduleFilter => ({
  agentId: context.agentId,
  AND: [
    { config: { path: ['createdViaTool'], equals: true } },
    ...(userId
      ? [{ config: { path: ['createdByUserId'], equals: userId } }]
      : []),
  ],
})

// Final ownership guard applied in JS. The DB filter narrows the user case, but
// it can't express "createdByUserId key absent", so an autonomous (no-user) call
// must additionally exclude schedules a named user created via this agent.
const scheduleBelongsToCaller = (config: unknown, userId: string | null): boolean => {
  const owner = asRecord(config)['createdByUserId']
  const ownerId = typeof owner === 'string' && owner.trim().length > 0 ? owner.trim() : null
  return userId ? ownerId === userId : ownerId === null
}

const describeStoredSchedule = (config: unknown): string => {
  const record = asRecord(config)
  if (record['mode'] === 'once' && typeof record['at'] === 'string') {
    return `once at ${record['at']}`
  }
  if (typeof record['cron'] === 'string') {
    const timezone =
      typeof record['timezone'] === 'string' ? ` (${record['timezone']})` : ''
    return `cron "${record['cron']}"${timezone}`
  }
  if (typeof record['interval_minutes'] === 'number') {
    return `every ${record['interval_minutes']} minute(s)`
  }
  return 'custom schedule'
}

export const runListScheduledTasksTool = async (
  context: BuiltinToolRuntimeContext,
): Promise<ToolExecutionResult> => {
  const userId = resolveEffectiveUserId(context)
  const allTriggers = await context.prisma.agentTrigger.findMany({
    where: buildOwnedScheduleWhere(context, userId),
    orderBy: [{ enabled: 'desc' }, { nextRunAt: 'asc' }],
    take: 50,
    select: {
      id: true,
      name: true,
      config: true,
      enabled: true,
      status: true,
      nextRunAt: true,
      targetChannel: { select: { label: true } },
    },
  })
  const triggers = allTriggers.filter((t) => scheduleBelongsToCaller(t.config, userId))

  if (triggers.length === 0) {
    return {
      inputSummary: 'list',
      outputPreview: 'You have no scheduled tasks.',
      toolName: 'list_scheduled_tasks',
    }
  }

  const lines = triggers.map((trigger) => {
    const record = asRecord(trigger.config)
    const label = trigger.name
    const prompt = typeof record['prompt'] === 'string' ? record['prompt'] : ''
    const channel = trigger.targetChannel?.label ? `#${trigger.targetChannel.label}` : 'a DM'
    const state = trigger.enabled ? 'active' : 'cancelled'
    const next = trigger.nextRunAt ? trigger.nextRunAt.toISOString() : 'n/a'
    return (
      `- [${trigger.id}] ${label ? `${label}: ` : ''}${prompt.slice(0, 80)} — ` +
      `${describeStoredSchedule(trigger.config)} → ${channel} (${state}, next ${next})`
    )
  })

  return {
    inputSummary: 'list',
    outputPreview: `Your scheduled tasks:\n${lines.join('\n')}`,
    toolName: 'list_scheduled_tasks',
  }
}

export const runCancelScheduledTaskTool = async (
  context: BuiltinToolRuntimeContext,
  input: { id?: unknown; name?: unknown },
): Promise<ToolExecutionResult> => {
  const id = typeof input.id === 'string' && input.id.trim().length > 0 ? input.id.trim() : null
  const name =
    typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : null
  if (!id && !name) {
    throw new Error('cancel_scheduled_task requires either "id" or "name".')
  }

  const userId = resolveEffectiveUserId(context)
  const base = buildOwnedScheduleWhere(context, userId)
  const trigger = await context.prisma.agentTrigger.findFirst({
    where: {
      ...base,
      AND: [
        ...base.AND,
        id ? { id } : { name: { equals: name as string, mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, enabled: true, config: true },
  })

  if (!trigger || !scheduleBelongsToCaller(trigger.config, userId)) {
    throw new Error(
      `No scheduled task found matching ${id ? `id "${id}"` : `name "${name}"`}.`,
    )
  }

  if (!trigger.enabled) {
    return {
      inputSummary: id ?? name ?? '',
      outputPreview: `Scheduled task ${trigger.id} is already cancelled.`,
      toolName: 'cancel_scheduled_task',
    }
  }

  await context.prisma.agentTrigger.update({
    where: { id: trigger.id },
    data: { enabled: false, status: 'paused' },
  })

  return {
    inputSummary: id ?? name ?? '',
    outputPreview: `Cancelled scheduled task ${trigger.id}${trigger.name ? ` ("${trigger.name}")` : ''}.`,
    toolName: 'cancel_scheduled_task',
  }
}
