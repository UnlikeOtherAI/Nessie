import type {
  Prisma,
  PrismaClient,
  UserStatus,
  UserStatusRule,
  UserStatusSchedule,
} from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseOrganizationId,
  parseProjectId,
  parseUserId,
} from '@nessie/schemas'
import type {
  CreateUserStatusBody,
  CreateUserStatusScheduleBody,
  UpdateUserStatusBody,
  UpdateUserStatusScheduleBody,
  UserActiveStatus,
  UserStatusRecord,
} from '../contracts/users-presence.js'
import { isScheduleActive } from './user-status-schedules.js'

const statusInclude = {
  schedules: { orderBy: { createdAt: 'asc' } },
  rules: { orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.UserStatusInclude

export type StatusWithRelations = UserStatus & {
  schedules: UserStatusSchedule[]
  rules: UserStatusRule[]
}

type StatusOwner = {
  organizationId: string
  userId: string
}
type RuleScope = 'fallback' | 'channel' | 'project'
type CreateRuleInput = {
  agentEnabled?: boolean
  agentId?: string | null
  channelId?: string | null
  instructions: string
  priority?: number
  projectId?: string | null
  scope: RuleScope
}
type UpdateRuleInput = Partial<Omit<CreateRuleInput, 'instructions'>> & { instructions?: string }

export class UserStatusServiceError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const cleanNullable = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) return undefined
  const trimmed = value?.trim() ?? ''
  return trimmed ? trimmed : null
}

const toDate = (value: string | null | undefined): Date | null | undefined => {
  if (value === undefined) return undefined
  if (value === null) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new UserStatusServiceError(400, 'INVALID_DATE', 'Invalid schedule date')
  }
  return date
}

const normalizeTimezone = (value: string | undefined): string => {
  const timezone = value?.trim() || 'UTC'
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone })
  } catch {
    throw new UserStatusServiceError(400, 'INVALID_TIMEZONE', 'Invalid schedule timezone')
  }
  return timezone
}

const isStatusActiveNow = (status: StatusWithRelations, now = new Date()): boolean =>
  status.isActive || status.schedules.some((schedule) => isScheduleActive(schedule, now))

const mapStatus = (status: StatusWithRelations, now = new Date()): UserStatusRecord => ({
  id: status.id,
  organizationId: parseOrganizationId(status.organizationId),
  userId: parseUserId(status.userId),
  label: status.label,
  emoji: status.emoji,
  isActive: status.isActive,
  activeNow: isStatusActiveNow(status, now),
  agentEnabled: status.agentEnabled,
  agentInstructions: status.agentInstructions,
  schedules: status.schedules.map((schedule) => ({
    id: schedule.id,
    statusId: schedule.statusId,
    kind: schedule.kind,
    label: schedule.label,
    enabled: schedule.enabled,
    startsAt: schedule.startsAt?.toISOString() ?? null,
    endsAt: schedule.endsAt?.toISOString() ?? null,
    dayOfWeek: schedule.dayOfWeek,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    timezone: schedule.timezone,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  })),
  rules: status.rules.map((rule) => ({
    id: rule.id,
    statusId: rule.statusId,
    scope: rule.scope,
    channelId: rule.channelId ? parseChannelId(rule.channelId) : null,
    projectId: rule.projectId ? parseProjectId(rule.projectId) : null,
    agentId: rule.agentId ? parseAgentId(rule.agentId) : null,
    agentEnabled: rule.agentEnabled,
    instructions: rule.instructions,
    priority: rule.priority,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  })),
  createdAt: status.createdAt.toISOString(),
  updatedAt: status.updatedAt.toISOString(),
})

export const resolveActiveStatus = (
  statuses: StatusWithRelations[],
  now = new Date(),
): UserActiveStatus | null => {
  const status =
    statuses.find((entry) => entry.isActive) ??
    statuses.find((entry) => entry.schedules.some((schedule) => isScheduleActive(schedule, now)))
  return status && isStatusActiveNow(status, now)
    ? { id: status.id, label: status.label, emoji: status.emoji, activeNow: true }
    : null
}

const ensureStatus = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  statusId: string,
): Promise<StatusWithRelations> => {
  const status = await prisma.userStatus.findFirst({
    where: { id: statusId, organizationId: owner.organizationId, userId: owner.userId },
    include: statusInclude,
  })
  if (!status) {
    throw new UserStatusServiceError(404, 'STATUS_NOT_FOUND', 'Status not found')
  }
  return status
}

const validateSchedule = (input: {
  kind: 'date_range' | 'weekly'
  startsAt: Date | null
  endsAt: Date | null
  dayOfWeek: number | null
  startTime: string | null
  endTime: string | null
}): void => {
  if (input.kind === 'date_range') {
    if (!input.startsAt || !input.endsAt || input.endsAt <= input.startsAt) {
      throw new UserStatusServiceError(400, 'INVALID_SCHEDULE', 'Date range end must be after start')
    }
    return
  }
  if (input.dayOfWeek === null || !input.startTime || !input.endTime) {
    throw new UserStatusServiceError(400, 'INVALID_SCHEDULE', 'Weekly schedule fields are required')
  }
}

const validateRuleTargets = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  input: {
    agentId: string | null
    channelId: string | null
    projectId: string | null
    scope: 'fallback' | 'channel' | 'project'
  },
): Promise<void> => {
  if (input.scope === 'channel' && !input.channelId) {
    throw new UserStatusServiceError(400, 'CHANNEL_REQUIRED', 'Channel rule requires a channel')
  }
  if (input.scope === 'project' && !input.projectId) {
    throw new UserStatusServiceError(400, 'PROJECT_REQUIRED', 'Project rule requires a project')
  }
  const [channel, project, agent] = await Promise.all([
    input.channelId
      ? prisma.channel.findFirst({
          where: { id: input.channelId, organizationId: owner.organizationId },
          select: { id: true },
        })
      : null,
    input.projectId
      ? prisma.project.findFirst({
          where: { id: input.projectId, organizationId: owner.organizationId },
          select: { id: true },
        })
      : null,
    input.agentId
      ? prisma.agent.findFirst({
          where: { id: input.agentId, organizationId: owner.organizationId },
          select: { id: true },
        })
      : null,
  ])
  if (input.channelId && !channel) {
    throw new UserStatusServiceError(404, 'CHANNEL_NOT_FOUND', 'Channel not found')
  }
  if (input.projectId && !project) {
    throw new UserStatusServiceError(404, 'PROJECT_NOT_FOUND', 'Project not found')
  }
  if (input.agentId && !agent) {
    throw new UserStatusServiceError(404, 'AGENT_NOT_FOUND', 'Agent not found')
  }
}

const normalizeRule = (
  input: CreateRuleInput | (UpdateRuleInput & { scope: RuleScope }),
) => ({
  scope: input.scope,
  channelId: input.scope === 'channel' ? input.channelId ?? null : null,
  projectId: input.scope === 'project' ? input.projectId ?? null : null,
  agentId: input.agentId ?? null,
})

export const listUserStatuses = async (
  prisma: PrismaClient,
  owner: StatusOwner,
): Promise<UserStatusRecord[]> => {
  const statuses = await prisma.userStatus.findMany({
    where: { organizationId: owner.organizationId, userId: owner.userId },
    include: statusInclude,
    orderBy: { createdAt: 'asc' },
  })
  return statuses.map((status) => mapStatus(status))
}

export const createUserStatus = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  input: CreateUserStatusBody,
): Promise<UserStatusRecord> => {
  const status = await prisma.userStatus.create({
    data: {
      organizationId: owner.organizationId,
      userId: owner.userId,
      label: input.label.trim(),
      emoji: cleanNullable(input.emoji),
      agentEnabled: input.agentEnabled ?? false,
      agentInstructions: cleanNullable(input.agentInstructions),
    },
    include: statusInclude,
  })
  return mapStatus(status)
}

export const getUserStatus = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  statusId: string,
): Promise<UserStatusRecord> => mapStatus(await ensureStatus(prisma, owner, statusId))

export const updateUserStatus = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  statusId: string,
  input: UpdateUserStatusBody,
): Promise<UserStatusRecord> => {
  await ensureStatus(prisma, owner, statusId)
  const status = await prisma.userStatus.update({
    where: { id: statusId },
    data: {
      ...(input.label !== undefined ? { label: input.label.trim() } : {}),
      ...(input.emoji !== undefined ? { emoji: cleanNullable(input.emoji) } : {}),
      ...(input.agentEnabled !== undefined ? { agentEnabled: input.agentEnabled } : {}),
      ...(input.agentInstructions !== undefined
        ? { agentInstructions: cleanNullable(input.agentInstructions) }
        : {}),
    },
    include: statusInclude,
  })
  return mapStatus(status)
}

export const deleteUserStatus = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  statusId: string,
): Promise<void> => {
  await ensureStatus(prisma, owner, statusId)
  await prisma.userStatus.delete({ where: { id: statusId } })
}

export const setActiveUserStatus = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  statusId: string,
): Promise<UserStatusRecord> => {
  await ensureStatus(prisma, owner, statusId)
  const status = await prisma.$transaction(async (transaction) => {
    await transaction.userStatus.updateMany({
      where: { organizationId: owner.organizationId, userId: owner.userId, isActive: true },
      data: { isActive: false },
    })
    return transaction.userStatus.update({
      where: { id: statusId },
      data: { isActive: true },
      include: statusInclude,
    })
  })
  return mapStatus(status)
}

export const clearActiveUserStatus = async (
  prisma: PrismaClient,
  owner: StatusOwner,
): Promise<void> => {
  await prisma.userStatus.updateMany({
    where: { organizationId: owner.organizationId, userId: owner.userId },
    data: { isActive: false },
  })
}

export const createUserStatusSchedule = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  statusId: string,
  input: CreateUserStatusScheduleBody,
): Promise<UserStatusRecord> => {
  await ensureStatus(prisma, owner, statusId)
  const startsAt = input.kind === 'date_range' ? toDate(input.startsAt) ?? null : null
  const endsAt = input.kind === 'date_range' ? toDate(input.endsAt) ?? null : null
  const dayOfWeek = input.kind === 'weekly' ? input.dayOfWeek ?? null : null
  const startTime = input.kind === 'weekly' ? input.startTime ?? null : null
  const endTime = input.kind === 'weekly' ? input.endTime ?? null : null
  validateSchedule({ kind: input.kind, startsAt, endsAt, dayOfWeek, startTime, endTime })
  await prisma.userStatusSchedule.create({
    data: {
      statusId,
      kind: input.kind,
      label: cleanNullable(input.label),
      enabled: input.enabled ?? true,
      startsAt,
      endsAt,
      dayOfWeek,
      startTime,
      endTime,
      timezone: normalizeTimezone(input.timezone),
    },
  })
  return getUserStatus(prisma, owner, statusId)
}

export const updateUserStatusSchedule = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  statusId: string,
  scheduleId: string,
  input: UpdateUserStatusScheduleBody,
): Promise<UserStatusRecord> => {
  const schedule = await prisma.userStatusSchedule.findFirst({
    where: { id: scheduleId, statusId, status: { organizationId: owner.organizationId, userId: owner.userId } },
  })
  if (!schedule) {
    throw new UserStatusServiceError(404, 'SCHEDULE_NOT_FOUND', 'Schedule not found')
  }
  const startsAt = toDate(input.startsAt) ?? schedule.startsAt
  const endsAt = toDate(input.endsAt) ?? schedule.endsAt
  const dayOfWeek = input.dayOfWeek === undefined ? schedule.dayOfWeek : input.dayOfWeek
  const startTime = input.startTime === undefined ? schedule.startTime : input.startTime
  const endTime = input.endTime === undefined ? schedule.endTime : input.endTime
  validateSchedule({ kind: schedule.kind, startsAt, endsAt, dayOfWeek, startTime, endTime })
  await prisma.userStatusSchedule.update({
    where: { id: scheduleId },
    data: {
      ...(input.label !== undefined ? { label: cleanNullable(input.label) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.startsAt !== undefined ? { startsAt } : {}),
      ...(input.endsAt !== undefined ? { endsAt } : {}),
      ...(input.dayOfWeek !== undefined ? { dayOfWeek } : {}),
      ...(input.startTime !== undefined ? { startTime } : {}),
      ...(input.endTime !== undefined ? { endTime } : {}),
      ...(input.timezone !== undefined ? { timezone: normalizeTimezone(input.timezone) } : {}),
    },
  })
  return getUserStatus(prisma, owner, statusId)
}

export const deleteUserStatusSchedule = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  statusId: string,
  scheduleId: string,
): Promise<UserStatusRecord> => {
  const result = await prisma.userStatusSchedule.deleteMany({
    where: { id: scheduleId, statusId, status: { organizationId: owner.organizationId, userId: owner.userId } },
  })
  if (result.count === 0) {
    throw new UserStatusServiceError(404, 'SCHEDULE_NOT_FOUND', 'Schedule not found')
  }
  return getUserStatus(prisma, owner, statusId)
}

export const createUserStatusRule = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  statusId: string,
  input: CreateRuleInput,
): Promise<UserStatusRecord> => {
  await ensureStatus(prisma, owner, statusId)
  const normalized = normalizeRule(input)
  await validateRuleTargets(prisma, owner, normalized)
  await prisma.userStatusRule.create({
    data: {
      statusId,
      ...normalized,
      agentEnabled: input.agentEnabled ?? true,
      instructions: input.instructions.trim(),
      priority: input.priority ?? 0,
    },
  })
  return getUserStatus(prisma, owner, statusId)
}

export const updateUserStatusRule = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  statusId: string,
  ruleId: string,
  input: UpdateRuleInput,
): Promise<UserStatusRecord> => {
  const existing = await prisma.userStatusRule.findFirst({
    where: { id: ruleId, statusId, status: { organizationId: owner.organizationId, userId: owner.userId } },
  })
  if (!existing) {
    throw new UserStatusServiceError(404, 'RULE_NOT_FOUND', 'Rule not found')
  }
  const nextScope = input.scope ?? existing.scope
  const normalized = normalizeRule({
    ...input,
    scope: nextScope,
    channelId: input.channelId === undefined ? existing.channelId : input.channelId,
    projectId: input.projectId === undefined ? existing.projectId : input.projectId,
    agentId: input.agentId === undefined ? existing.agentId : input.agentId,
  })
  await validateRuleTargets(prisma, owner, normalized)
  await prisma.userStatusRule.update({
    where: { id: ruleId },
    data: {
      ...normalized,
      ...(input.agentEnabled !== undefined ? { agentEnabled: input.agentEnabled } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions.trim() } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    },
  })
  return getUserStatus(prisma, owner, statusId)
}

export const deleteUserStatusRule = async (
  prisma: PrismaClient,
  owner: StatusOwner,
  statusId: string,
  ruleId: string,
): Promise<UserStatusRecord> => {
  const result = await prisma.userStatusRule.deleteMany({
    where: { id: ruleId, statusId, status: { organizationId: owner.organizationId, userId: owner.userId } },
  })
  if (result.count === 0) {
    throw new UserStatusServiceError(404, 'RULE_NOT_FOUND', 'Rule not found')
  }
  return getUserStatus(prisma, owner, statusId)
}
