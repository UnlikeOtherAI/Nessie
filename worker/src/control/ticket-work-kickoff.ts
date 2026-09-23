import type { Prisma } from '@prisma/client'
import {
  TICKET_TRIGGER_LIMIT_DEFAULTS,
  TicketChangedStoredConfigSchema,
  TicketTriggerInstructionsSchema,
  TicketTriggerLimitsSchema,
  type TicketFollowKind,
  type TicketTriggerLimits,
  type TicketTriggerInstructions,
  type TicketWorkKickoffEvent,
  type TicketWorkWakeReason,
} from '@nessie/schemas'
import { resolveProjectTaskDetailPlacement } from '@nessie/team-admin'

/**
 * A `ticket.work` kickoff: three blocks rebuilt from the work record on every
 * wake, whatever woke it (docs/standards/ticket-work.md → "What every wake
 * says"). Kickoffs are `system` messages, and a later run's conversation drops
 * them, so a weak model never has to remember the plan or the state: each wake
 * tells it again — why it was woken, where the ticket and its work stand, and
 * the trigger's instructions for that reason.
 */

type Column = { id: string; name: string; category: string }

/**
 * A trigger's work settings, each read on its own: a field that no longer
 * parses (a hand-edited instruction, say) costs that field alone, never the
 * limits the platform enforces or the kinds of change it follows.
 */
export const ticketWorkConfigOf = (config: unknown): {
  limits: TicketTriggerLimits
  instructions: TicketTriggerInstructions | undefined
  followKinds: readonly TicketFollowKind[]
} => {
  const record = config && typeof config === 'object' ? config as Record<string, unknown> : {}
  const limits = TicketTriggerLimitsSchema.safeParse(record['limits'])
  const instructions = TicketTriggerInstructionsSchema.safeParse(record['instructions'])
  const stored = TicketChangedStoredConfigSchema.safeParse(config)
  return {
    limits: limits.success ? limits.data : { ...TICKET_TRIGGER_LIMIT_DEFAULTS },
    instructions: instructions.success ? instructions.data : undefined,
    followKinds: stored.success ? stored.data.follow.kinds : [],
  }
}

export type TicketWorkKickoffFacts = {
  ticket: {
    id: string
    title: string | null
    priority: string
    externalKey: string | null
    assignee: string | null
  }
  board: { name: string; columns: Column[] } | null
  column: Column | null
  work: {
    startedAt: Date
    startedBy: string | null
    wakeNumber: number
    wakeLimit: number
    pullRequestUrl: string | null
  }
  followKinds: readonly TicketFollowKind[]
  instructions: TicketTriggerInstructions | undefined
}

/** Which instruction section follows `general` for each reason. */
const SECTION_FOR_REASON: Partial<Record<TicketWorkWakeReason, keyof TicketTriggerInstructions>> = {
  pickup: 'onPickup',
  dequeued: 'onPickup',
  queued: 'onQueued',
  ticket_commented: 'onTicketChanged',
  ticket_description_changed: 'onTicketChanged',
  ticket_priority_changed: 'onTicketChanged',
  ticket_labels_changed: 'onTicketChanged',
  ticket_assignee_changed: 'onTicketChanged',
  ticket_moved: 'onTicketChanged',
  thread_message: 'onTicketChanged',
  document_changed: 'onTicketChanged',
  session_turn_ended: 'onSessionTurnEnded',
  session_interrupted: 'onSessionTurnEnded',
  session_failed: 'onSessionTurnEnded',
  session_closed: 'onSessionTurnEnded',
  reminder: 'onReminder',
}

/** What each followed kind wakes the agent for, said the way the state block ends. */
const FOLLOW_PHRASES: Record<TicketFollowKind, string> = {
  comment: 'comments',
  description: 'edits the description',
  moved: 'moves the ticket',
  thread_message: 'writes in this thread',
  document: 'edits one of its documents',
  priority: 'changes the priority',
  labels: 'changes the labels',
  assignee: 'changes the assignee',
}

const minute = (at: Date): string => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`

const whyBlock = (events: readonly TicketWorkKickoffEvent[]): string[] => {
  if (events.length === 1) {
    const [event] = events
    return ['## Why you were woken', `${event!.reason}: ${event!.text}`]
  }
  return [
    '## Why you were woken',
    `Since your last run, in order (${events.length} changes):`,
    ...events.map((event, index) => `${index + 1}. ${event.reason}: ${event.text}`),
  ]
}

const stateBlock = (facts: TicketWorkKickoffFacts): string[] => {
  const { ticket, board, column, work } = facts
  // A document edit reaches a ticket's work only once the document trigger
  // ships (T2), so it is not promised here before then.
  const followed = facts.followKinds.filter((kind) => kind !== 'document').map((kind) => FOLLOW_PHRASES[kind])
  return [
    '## State',
    `Ticket "${ticket.title ?? 'Untitled'}" (ticketId=${ticket.id})${ticket.externalKey ? `, mirrored as ${ticket.externalKey}` : ''}`
      + `, board ${board?.name ?? 'none'}, column ${column ? `${column.name} (${column.category})` : 'none'}`
      + `, priority ${ticket.priority}, assigned to ${ticket.assignee ?? 'nobody'}.`,
    board
      ? `Columns: ${board.columns.map((entry) => `${entry.name} (${entry.category}) columnId=${entry.id}`).join('; ')}.`
      : 'The ticket is on no board.',
    `Work: started ${minute(work.startedAt)}${work.startedBy ? ` by ${work.startedBy}` : ''}; this is wake ${work.wakeNumber} of ${work.wakeLimit}.`,
    'Machine: none. No machine does ticket work yet, so you cannot run or change code: '
      + 'read the ticket, comment on it and move it.',
    `Pull request: ${work.pullRequestUrl ?? 'none on record'}.`,
    'This conversation is the ticket\'s work thread. After this run you are woken again when a person who can '
      + `edit the board ${followed.length > 0 ? followed.join(', ') : 'moves the ticket back into a start-work column'}`
      + '. Your own changes to the ticket never wake you.',
  ]
}

const instructionsBlock = (
  instructions: TicketTriggerInstructions | undefined,
  events: readonly TicketWorkKickoffEvent[],
): string[] => {
  if (!instructions) {
    return ['## Instructions', 'Nobody has written instructions for this trigger yet. Read the ticket and comment on it.']
  }
  const sections = [...new Set(events.flatMap((event) => {
    const key = SECTION_FOR_REASON[event.reason]
    return key && key !== 'general' ? [key] : []
  }))]
  return [
    '## Instructions',
    instructions.general,
    ...sections.flatMap((key) => (instructions[key] ? [instructions[key]!] : [])),
  ]
}

export const renderTicketWorkKickoff = (
  facts: TicketWorkKickoffFacts,
  events: readonly TicketWorkKickoffEvent[],
): string => [
  ...whyBlock(events),
  '',
  ...stateBlock(facts),
  '',
  ...instructionsBlock(facts.instructions, events),
].join('\n')

/**
 * Everything the state block says, read afresh from the record, its ticket and
 * its trigger — inside the wake's transaction, which may have just written the
 * record.
 */
export const loadTicketWorkKickoffFacts = async (
  prisma: Pick<Prisma.TransactionClient, 'agentTicketWork' | 'board' | 'taskBoardPlacement'>,
  input: {
    workId: string
    /** The wake this kickoff is for, counted before the record is written. */
    wakeNumber: number
    trigger: { config: unknown }
  },
): Promise<TicketWorkKickoffFacts> => {
  const work = await prisma.agentTicketWork.findUniqueOrThrow({
    where: { id: input.workId },
    select: {
      startedAt: true,
      pullRequestUrl: true,
      startedBy: { select: { displayName: true } },
      task: {
        select: {
          id: true,
          title: true,
          priority: true,
          status: true,
          projectId: true,
          boardId: true,
          archivedAt: true,
          externalLink: { select: { externalKey: true } },
          assignee: { select: { displayName: true } },
          assigneeAgent: { select: { name: true } },
        },
      },
    },
  })
  const config = ticketWorkConfigOf(input.trigger.config)
  const placement = await resolveProjectTaskDetailPlacement(prisma, work.task)
  const board = placement
    ? await prisma.board.findUnique({
        where: { id: placement.boardId },
        select: { name: true, columns: { select: { id: true, name: true, category: true }, orderBy: { position: 'asc' } } },
      })
    : null
  return {
    ticket: {
      id: work.task.id,
      title: work.task.title,
      priority: work.task.priority,
      externalKey: work.task.externalLink?.externalKey ?? null,
      assignee: work.task.assignee?.displayName ?? work.task.assigneeAgent?.name ?? null,
    },
    board,
    column: board?.columns.find((entry) => entry.id === placement?.columnId) ?? null,
    work: {
      startedAt: work.startedAt,
      startedBy: work.startedBy?.displayName ?? null,
      wakeNumber: input.wakeNumber,
      wakeLimit: config.limits.wakesPerTicket,
      pullRequestUrl: work.pullRequestUrl,
    },
    followKinds: config.followKinds,
    instructions: config.instructions,
  }
}
