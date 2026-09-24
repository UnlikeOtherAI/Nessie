import { Prisma } from '@prisma/client'
import {
  TicketChangedStoredConfigSchema,
  TicketChangedTriggerConfigSchema,
  TicketChangedWorkConfigSchema,
  type TicketChangedTriggerConfig,
  type TicketEndOn,
} from '@nessie/schemas'

import {
  refusalsFromZodError,
  TriggerConfigRefusalError,
  type TriggerConfigRefusal,
} from './trigger-config-refusal.js'

/**
 * A `ticket_changed` trigger's configuration, resolved on the server
 * (docs/plans/2026-09-23-ticket-driven-agents/triggers.md, "Configuration";
 * docs/standards/ticket-work.md).
 *
 * The project comes from the target channel, never from the caller; the board
 * may be left out when that project has one; a column may be named by id, by
 * name or by category, and is stored by id. Every refusal names the field and
 * what exists instead, so a person or a model can fix the one thing that is
 * wrong. Resolution runs inside the write's transaction, because the
 * one-pickup-per-column rule takes a lock on the board.
 */

type Column = { category: string; id: string; name: string }
type Board = { columns: Column[]; id: string; name: string; projectId: string }

export type TicketTriggerResolution = {
  /** The stored config (`TicketChangedStoredConfigSchema`), limits and instructions included. */
  config: Record<string, unknown>
  scopeBoardId: string
  scopeProjectId: string
  targetChannelId: string
}

export type TicketTriggerResolveInput = {
  agent: { id: string; name: string; organizationId: string }
  /** The client config, server-owned keys already stripped. */
  config: Record<string, unknown>
  /** Whether the trigger is enabled once this write lands. */
  enabled: boolean
  /** The trigger being edited, which never conflicts with itself. */
  excludeTriggerId?: string
  nextRunAt?: string | null
  targetChannelId?: string | null
  targetThreadId?: string | null
}

const refuse = (path: string, reason: string): never => {
  throw new TriggerConfigRefusalError([{ path, reason }])
}

const columnList = (board: Board): string =>
  `(columns: ${board.columns.map((column) => column.name).join(', ')})`

/** The advisory lock that serializes pickup-column claims on one board. */
const lockBoardPickups = async (tx: Prisma.TransactionClient, boardId: string): Promise<void> => {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ticket-trigger-pickup:${boardId}`}, 0))`,
  )
}

const resolveChannel = async (tx: Prisma.TransactionClient, input: TicketTriggerResolveInput) => {
  const channelId = input.targetChannelId
  if (!channelId) {
    return refuse(
      'targetChannelId',
      'a ticket trigger needs the channel its work threads open in: a public channel of the board\'s '
      + 'project that the agent is bound to',
    )
  }
  const channel = await tx.channel.findFirst({
    where: { deletedAt: null, id: channelId, organizationId: input.agent.organizationId, project: { deletedAt: null } },
    select: {
      archivedAt: true,
      dmKey: true,
      id: true,
      label: true,
      project: { select: { name: true } },
      projectId: true,
      systemChannelType: true,
      type: true,
      visibility: true,
    },
  })
  if (!channel) return refuse('targetChannelId', 'no such channel in this organisation')
  const room = `#${channel.label}`
  if (channel.archivedAt) return refuse('targetChannelId', `${room} is archived; pick a live channel`)
  if (channel.type !== 'standard' || channel.systemChannelType || channel.dmKey) {
    return refuse(
      'targetChannelId',
      `${room} is a direct or system conversation; a ticket trigger works in an ordinary project channel`,
    )
  }
  if (channel.visibility !== 'public') {
    return refuse(
      'targetChannelId',
      `${room} is ${channel.visibility}. A ticket trigger's channel must be public, so that everyone who `
      + 'can read a ticket can open its work thread',
    )
  }
  const bound = await tx.agentBinding.count({ where: { agentId: input.agent.id, channelId: channel.id } })
  if (bound === 0) {
    return refuse('targetChannelId', `${input.agent.name} is not in ${room}; add it to the channel first`)
  }
  return channel
}

const boardSelect = {
  columns: { orderBy: { position: 'asc' }, select: { category: true, id: true, name: true } },
  id: true,
  name: true,
  projectId: true,
} satisfies Prisma.BoardSelect

const resolveBoard = async (
  tx: Prisma.TransactionClient,
  organizationId: string,
  channel: { label: string; project: { name: string }; projectId: string },
  boardId: string | undefined,
): Promise<Board> => {
  if (boardId) {
    const board = await tx.board.findFirst({ where: { id: boardId, organizationId }, select: boardSelect })
    if (!board) return refuse('boardId', 'no such board in this organisation')
    if (board.projectId !== channel.projectId) {
      return refuse(
        'boardId',
        `board ${board.name} is in another project than #${channel.label} (project ${channel.project.name}); `
        + 'a ticket trigger works a board of its channel\'s project',
      )
    }
    return board
  }
  const boards = await tx.board.findMany({
    where: { projectId: channel.projectId },
    orderBy: { position: 'asc' },
    select: boardSelect,
  })
  if (boards.length === 1) return boards[0]!
  if (boards.length === 0) return refuse('boardId', `project ${channel.project.name} has no board yet`)
  return refuse(
    'boardId',
    `project ${channel.project.name} has ${boards.length} boards, so name one: `
    + boards.map((board) => `${board.name} (boardId=${board.id})`).join(', '),
  )
}

type PickupColumn = { column: Column; index: number }

const resolvePickup = (
  board: Board,
  columns: NonNullable<TicketChangedTriggerConfig['pickup']>['columns'],
  refusals: TriggerConfigRefusal[],
): PickupColumn[] => columns.flatMap((ref, index): PickupColumn[] => {
  const path = `pickup.columns[${index}]`
  if ('id' in ref) {
    const column = board.columns.find((candidate) => candidate.id === ref.id)
    if (column) return [{ column, index }]
    refusals.push({ path, reason: `no column with id ${ref.id} on board ${board.name} ${columnList(board)}` })
    return []
  }
  if ('name' in ref) {
    const wanted = ref.name.trim().toLowerCase()
    const matches = board.columns.filter((candidate) => candidate.name.trim().toLowerCase() === wanted)
    if (matches.length === 1) return [{ column: matches[0]!, index }]
    refusals.push({
      path,
      reason: matches.length === 0
        ? `no column "${ref.name}" on board ${board.name} ${columnList(board)}`
        : `board ${board.name} has ${matches.length} columns named "${ref.name}"; name one by its id`,
    })
    return []
  }
  const matches = board.columns.filter((candidate) => candidate.category === ref.category)
  if (matches.length === 0) {
    refusals.push({ path, reason: `board ${board.name} has no ${ref.category} column ${columnList(board)}` })
  }
  return matches.map((column) => ({ column, index }))
})

const endsWork = (column: Column, endOn: readonly TicketEndOn[]): boolean =>
  endOn.some((end) => ('id' in end ? end.id === column.id : end.category === column.category))

const checkEndOn = (board: Board, endOn: readonly TicketEndOn[], refusals: TriggerConfigRefusal[]): void => {
  endOn.forEach((end, index) => {
    if ('id' in end && !board.columns.some((column) => column.id === end.id)) {
      refusals.push({
        path: `endOn[${index}]`,
        reason: `no column with id ${end.id} on board ${board.name} ${columnList(board)}`,
      })
    }
  })
}

const triggerLabel = (trigger: { agent: { name: string } | null; name: string | null }): string =>
  `"${trigger.name ?? 'unnamed ticket trigger'}"${trigger.agent ? ` of ${trigger.agent.name}` : ''}`

/**
 * At most one enabled `ticket_changed` trigger picks up from a column, so two
 * agents never start on the same ticket. Checked under the board's lock, so two
 * writes racing for one column cannot both pass.
 */
const checkPickupConflicts = async (
  tx: Prisma.TransactionClient,
  input: { board: Board; excludeTriggerId?: string; pickup: readonly PickupColumn[] },
  refusals: TriggerConfigRefusal[],
): Promise<void> => {
  await lockBoardPickups(tx, input.board.id)
  const others = await tx.agentTrigger.findMany({
    where: {
      enabled: true,
      scopeBoardId: input.board.id,
      type: 'ticket_changed',
      ...(input.excludeTriggerId ? { id: { not: input.excludeTriggerId } } : {}),
    },
    select: { agent: { select: { name: true } }, config: true, id: true, name: true },
  })
  for (const other of others) {
    const parsed = TicketChangedStoredConfigSchema.safeParse(other.config)
    const claimed = new Set(parsed.success ? parsed.data.pickup?.columnIds ?? [] : [])
    for (const { column, index } of input.pickup) {
      if (!claimed.has(column.id)) continue
      refusals.push({
        path: `pickup.columns[${index}]`,
        reason: `column "${column.name}" is already a start-work column of the enabled trigger `
          + `${triggerLabel(other)} (triggerId=${other.id}), and two agents would start on the same ticket. `
          + 'Disable that trigger, or pick another column',
        triggerId: other.id,
      })
    }
  }
}

/**
 * Resolve and check a `ticket_changed` trigger's config, or throw
 * `TriggerConfigRefusalError` naming every field that is wrong. Call it inside
 * the transaction that writes the trigger.
 */
export const resolveTicketChangedTrigger = async (
  tx: Prisma.TransactionClient,
  input: TicketTriggerResolveInput,
): Promise<TicketTriggerResolution> => {
  const refusals: TriggerConfigRefusal[] = []
  if (input.targetThreadId) {
    refusals.push({
      path: 'targetThreadId',
      reason: 'a ticket trigger opens one thread per ticket in its channel; give targetChannelId only',
    })
  }
  if (input.nextRunAt) {
    refusals.push({ path: 'nextRunAt', reason: 'a ticket trigger runs when a ticket changes, not on a schedule' })
  }
  const parsed = TicketChangedTriggerConfigSchema.safeParse(input.config)
  if (!parsed.success) refusals.push(...refusalsFromZodError(parsed.error))
  if (refusals.length > 0 || !parsed.success) throw new TriggerConfigRefusalError(refusals)
  const config = parsed.data

  const channel = await resolveChannel(tx, input)
  const board = await resolveBoard(tx, input.agent.organizationId, channel, config.boardId)
  const pickup = config.pickup ? resolvePickup(board, config.pickup.columns, refusals) : []
  checkEndOn(board, config.endOn, refusals)
  for (const { column, index } of pickup) {
    if (!endsWork(column, config.endOn)) continue
    refusals.push({
      path: `pickup.columns[${index}]`,
      reason: `column "${column.name}" ends the work (endOn), so it cannot also start it`,
    })
  }
  if (refusals.length > 0) throw new TriggerConfigRefusalError(refusals)
  if (input.enabled && pickup.length > 0) {
    await checkPickupConflicts(tx, { board, excludeTriggerId: input.excludeTriggerId, pickup }, refusals)
    if (refusals.length > 0) throw new TriggerConfigRefusalError(refusals)
  }

  const columnIds = [...new Set(pickup.map(({ column }) => column.id))]
  return {
    config: {
      boardId: board.id,
      pickup: config.pickup ? { assignOnPickup: config.pickup.assignOnPickup, columnIds } : null,
      follow: config.follow,
      endOn: config.endOn,
      quietWakeMinutes: config.quietWakeMinutes,
      limits: config.limits,
      instructions: config.instructions,
    },
    scopeBoardId: board.id,
    scopeProjectId: channel.projectId,
    targetChannelId: channel.id,
  }
}

/**
 * A stored config written back in the typed input's words, so an update can
 * change one key and have the rest resolved again as they were: the board and
 * the pickup columns by id, everything else as stored. A config that no longer
 * parses keeps nothing, and the update then has to give every key.
 */
export const ticketChangedConfigAsInput = (stored: unknown): Record<string, unknown> => {
  const parsed = TicketChangedWorkConfigSchema.safeParse(stored)
  if (!parsed.success) return {}
  const { boardId, endOn, follow, instructions, limits, pickup, quietWakeMinutes } = parsed.data
  return {
    boardId,
    endOn,
    follow,
    limits,
    quietWakeMinutes,
    pickup: pickup
      ? { assignOnPickup: pickup.assignOnPickup, columns: pickup.columnIds.map((id) => ({ id })) }
      : null,
    ...(instructions ? { instructions } : {}),
  }
}

/** The keys of the config that are objects, which an edit merges one level deep. */
const NESTED_CONFIG_KEYS = ['follow', 'limits', 'instructions', 'pickup'] as const

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * An edit's config patch laid over the stored config in the input's words
 * (`ticketChangedConfigAsInput`): a top-level key replaces, and an object key
 * — `follow`, `limits`, `instructions`, `pickup` — merges one level deep, so a
 * patch naming `follow.kinds` keeps the `follow.includeSourceEvents` a person
 * chose, and `limits.wakesPerTicket` keeps `startsPerDay`. `pickup: null`
 * still clears the start-work columns, and an array is replaced whole.
 */
export const mergeTicketConfigPatch = (
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...stored, ...patch }
  for (const key of NESTED_CONFIG_KEYS) {
    const before = stored[key]
    const next = patch[key]
    if (isPlainObject(before) && isPlainObject(next)) merged[key] = { ...before, ...next }
  }
  return merged
}

/**
 * Why a stored `ticket_changed` trigger may not be switched back on without
 * an edit (a resume), or null when it may. The stored config is resolved
 * exactly as a create or an edit would resolve it — a live, ordinary, public
 * target channel the agent is in, instructions, a board of that channel's
 * project, one enabled pickup per column — so a resume never enables a
 * trigger in a state a create would refuse: a board watcher migrated with no
 * channel and no instructions, say, or one whose channel went private. Call
 * it inside the transaction that enables the trigger.
 */
export const ticketTriggerResumeRefusal = async (
  tx: Prisma.TransactionClient,
  trigger: {
    agent: { id: string; name: string; organizationId: string | null } | null
    config: unknown
    id: string
    targetChannelId: string | null
  },
): Promise<string | null> => {
  const agent = trigger.agent
  if (!agent?.organizationId) return 'This ticket trigger\'s agent is gone, so it cannot be resumed.'
  try {
    await resolveTicketChangedTrigger(tx, {
      agent: { id: agent.id, name: agent.name, organizationId: agent.organizationId },
      config: ticketChangedConfigAsInput(trigger.config),
      enabled: true,
      excludeTriggerId: trigger.id,
      targetChannelId: trigger.targetChannelId,
    })
    return null
  } catch (error) {
    if (!(error instanceof TriggerConfigRefusalError)) throw error
    return `Edit this ticket trigger before resuming it — ${
      error.refusals.map((refusal) => `${refusal.path}: ${refusal.reason}`).join('; ')}.`
  }
}

/**
 * The one-pickup rule for a trigger being switched back on without an edit
 * (a resume): its stored pickup columns against every other enabled trigger
 * on its board. Returns the refusal sentence, or null. Call it inside the
 * transaction that enables the trigger.
 */
export const ticketTriggerPickupConflict = async (
  tx: Prisma.TransactionClient,
  trigger: { config: unknown; id: string; scopeBoardId: string | null },
): Promise<string | null> => {
  const parsed = TicketChangedStoredConfigSchema.safeParse(trigger.config)
  if (!trigger.scopeBoardId || !parsed.success || !parsed.data.pickup) return null
  const board = await tx.board.findUnique({ where: { id: trigger.scopeBoardId }, select: boardSelect })
  if (!board) return null
  const pickup = board.columns
    .filter((column) => parsed.data.pickup!.columnIds.includes(column.id))
    .map((column, index) => ({ column, index }))
  const refusals: TriggerConfigRefusal[] = []
  await checkPickupConflicts(tx, { board, excludeTriggerId: trigger.id, pickup }, refusals)
  return refusals.length > 0 ? refusals.map((refusal) => refusal.reason).join('; ') : null
}
