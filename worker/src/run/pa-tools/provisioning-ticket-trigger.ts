import { TicketChangedStoredConfigSchema, type AgentTriggerRecord } from '@nessie/schemas'

import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import type { ActingMember } from './access.js'
import { recordProjectRead } from './ticket-context.js'
import { formatBoardMarkdownLink } from './tool-output.js'

const PROVIDER_NAMES: Record<string, string> = { github: 'GitHub', jira: 'Jira', linear: 'Linear', trello: 'Trello' }

/**
 * A mirrored project's line: a ticket moved on the connected board never
 * starts work here (docs/plans/2026-09-23-ticket-driven-agents/triggers.md →
 * "Board watchers"), so a trigger set up on such a board says so, and says
 * what the connected board's own changes can still do. Null when nothing is
 * mirrored.
 */
export const describeMirroredSources = (
  sources: readonly { name: string; provider: string }[],
  includeSourceEvents: boolean,
): string | null => {
  if (sources.length === 0) return null
  const named = sources.map((source) => `${PROVIDER_NAMES[source.provider] ?? source.provider} "${source.name}"`)
  return `This project mirrors ${named.join(', ')}: a ticket moved there never starts work; only a person `
    + 'moving it on this board does. '
    + (includeSourceEvents
      ? 'Its own changes wake live work, and reach the agent marked untrusted.'
      : 'Its own changes wake nothing unless the trigger includes source events.')
}

/**
 * What a `ticket_changed` trigger resolved to, said back after
 * `agent_trigger_create` or `agent_trigger_update`: the board as a link, and
 * the start-work and end columns it stored by id, by name and category. A
 * person or the Designer named them by name or category; this is where they
 * see which columns those words became. A column has no page of its own, so
 * it is named on its board, with the columnId a later edit may take.
 *
 * The acting member is an organisation owner (both tools require it), so the
 * board and its columns are theirs to read; the names still stamp the
 * project, as `ticket_board_read` stamps them.
 */
export const describeTicketTriggerScope = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  trigger: AgentTriggerRecord,
): Promise<string[]> => {
  if (trigger.type !== 'ticket_changed') return []
  const parsed = TicketChangedStoredConfigSchema.safeParse(trigger.config)
  if (!parsed.success) return []
  const config = parsed.data
  const board = await context.prisma.board.findFirst({
    where: { id: config.boardId, organizationId: member.organizationId },
    select: {
      columns: { orderBy: { position: 'asc' }, select: { category: true, id: true, name: true } },
      id: true,
      name: true,
      projectId: true,
    },
  })
  if (!board) return []
  recordProjectRead(context, member, board.projectId)
  const mirrored = describeMirroredSources(
    await context.prisma.boardSource.findMany({
      where: { organizationId: member.organizationId, projectId: board.projectId },
      orderBy: { name: 'asc' },
      select: { name: true, provider: true },
    }),
    config.follow.includeSourceEvents,
  )
  const column = (candidate: { category: string; id: string; name: string }) =>
    `${candidate.name} (${candidate.category}, columnId=${candidate.id})`
  const pickup = board.columns.filter((candidate) => config.pickup?.columnIds.includes(candidate.id))
  const ends = board.columns.filter((candidate) =>
    config.endOn.some((end) => ('id' in end ? end.id === candidate.id : end.category === candidate.category)))
  return [
    pickup.length > 0
      ? `Starts work when a person who can edit ${formatBoardMarkdownLink(board)} moves a ticket into `
        + `${pickup.map(column).join(' or ')}`
        + (config.pickup?.assignOnPickup ? ', and assigns an unassigned ticket to the agent' : '')
      : `Starts no work itself; it follows work on ${formatBoardMarkdownLink(board)}`,
    `Ends the work in ${ends.length > 0 ? ends.map(column).join(', ') : 'no column on this board'}`,
    `Wakes the agent on: ${config.follow.kinds.join(', ')}`
    + (config.follow.includeSourceEvents ? ' (the connected board\'s own changes too)' : ''),
    ...(mirrored ? [mirrored] : []),
  ]
}
