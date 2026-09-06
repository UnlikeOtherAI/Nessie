import {
  listAccessibleProjectIds,
  listAssignableProjectTaskUsers,
  listUnmappedTicketPeople,
  searchProjectTasks,
  searchRemoteTickets,
} from '@nessie/team-admin'
import { z } from 'zod'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember, type ActingMember } from './access.js'
import {
  IdSchema,
  PrioritySchema,
  TicketStatusSchema,
  projectFor,
  recordProjectRead,
  result,
  ticketLine,
} from './ticket-context.js'

/**
 * Finding tickets, and the people who hold them.
 *
 * Separate from `tickets.ts` for the reason `project-task-search.ts` is
 * separate from `project-tasks.ts`: that file is the ticket lifecycle, and
 * this one has to understand people the lifecycle never mentions — the
 * provider users a mirrored ticket names that Nessie has no account for.
 */

/**
 * Which projects this search may see, asked the same way the routes ask it:
 * an owner reaches everything, everybody else reaches their memberships plus
 * the projectless, owned and assigned work `projectTaskVisibilityWhere` adds.
 * A search is the one ticket read with no explicit project to gate, so the
 * gate has to travel with the query instead of preceding it.
 */
const searchVisibilityFor = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
) => {
  const accessible = await listAccessibleProjectIds(context.prisma, member)
  return accessible === 'all'
    ? undefined
    : { accessibleProjectIds: accessible, actorUserId: member.userId }
}

/**
 * The same authority as `searchVisibilityFor`, resolved to a concrete list.
 *
 * Not a second spelling of it: a local search pushes visibility into the query,
 * where it can also admit the projectless, owned and assigned work a task row
 * carries on its own. A provider search has no such rows to reason about — it
 * asks a `BoardSource`, which always belongs to exactly one project — so the
 * gate has to be the project list itself.
 */
const searchableProjectIds = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  projectId?: string,
): Promise<string[]> => {
  if (projectId) {
    await projectFor(context, member, projectId)
    return [projectId]
  }
  const accessible = await listAccessibleProjectIds(context.prisma, member)
  if (accessible !== 'all') return accessible
  const projects = await context.prisma.project.findMany({
    where: { organizationId: member.organizationId },
    select: { id: true },
  })
  return projects.map((project) => project.id)
}

const SearchInput = z.object({
  text: z.string().optional(),
  projectId: IdSchema.optional(),
  boardId: IdSchema.optional(),
  status: TicketStatusSchema.optional(),
  priority: PrioritySchema.optional(),
  assigneeUserId: IdSchema.optional(),
  unmappedAssignee: z.string().min(1).optional(),
  unassigned: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
})

export const runTicketSearchTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = SearchInput.parse(input)
  const member = await resolveActingMember(context)
  if (args.projectId) await projectFor(context, member, args.projectId)

  const tickets = await searchProjectTasks(
    context.prisma,
    member.organizationId,
    args,
    await searchVisibilityFor(context, member),
  )

  // A search crosses projects, so the basis is every project it actually
  // answered from — not the one project a caller happened to name.
  for (const projectId of new Set(tickets.map((ticket) => ticket.projectId))) {
    if (projectId) recordProjectRead(context, member, projectId)
  }

  const summary = Object.entries(args)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ') || 'everything'
  const output = tickets.length
    ? `Tickets (${tickets.length})\n${tickets.map(ticketLine).join('\n')}`
    : 'No tickets matched.'
  return result('ticket_search', summary, output)
}

const PeopleInput = z.object({ projectId: IdSchema.optional() })

export const runTicketPeopleReadTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = PeopleInput.parse(input)
  const member = await resolveActingMember(context)
  if (args.projectId) {
    await projectFor(context, member, args.projectId)
    recordProjectRead(context, member, args.projectId)
  }

  const [people, unmapped] = await Promise.all([
    listAssignableProjectTaskUsers(context.prisma, member.organizationId),
    listUnmappedTicketPeople(context.prisma, member.organizationId, {
      projectId: args.projectId,
    }),
  ])

  const lines = [
    `In Nessie (${people.length})`,
    ...people.map((person) => `- ${person.displayName} | assigneeUserId=${person.id}`),
    `Not in Nessie (${unmapped.length})`,
    // Named as what they are: a provider's own user, with no account here. The
    // remedy is the same one the board card offers.
    ...unmapped.map(
      (person) =>
        `- ${person.displayName} | ${person.provider} user, no Nessie account` +
        ` | unmappedAssignee=${person.externalUserId ?? person.displayName}` +
        ` | tickets=${person.ticketCount}`,
    ),
  ]
  if (unmapped.length > 0) {
    lines.push(
      'Link a provider user to a colleague in Settings → Sources → People;' +
        ' until then they can only be searched with unmappedAssignee.',
    )
  }
  return result(
    'ticket_people_read',
    args.projectId ? `projectId=${args.projectId}` : 'organisation',
    lines.join('\n'),
  )
}

const RemoteInput = z.object({
  text: z.string().min(1),
  projectId: IdSchema.optional(),
  limit: z.number().int().positive().optional(),
})

/**
 * Ask the connected providers directly, for work Nessie has not mirrored.
 *
 * The mirror is still where a board's tickets come from, and everything this
 * returns is read-only: an item outside the sync window or newer than the last
 * sweep can be *found* here, but acting on it goes through the ticket tools
 * once the sync has it. Saying which items are already mirrored is what makes
 * that difference usable rather than confusing.
 */
export const runTicketSearchRemoteTool = async (
  context: BuiltinToolRuntimeContext,
  input: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const args = RemoteInput.parse(input)
  const member = await resolveActingMember(context)
  if (!context.boardSourceEncryptionSecret) {
    throw new Error('This deployment cannot read source credentials, so I cannot search them.')
  }

  const projectIds = await searchableProjectIds(context, member, args.projectId)
  if (projectIds.length === 0) {
    return result(
      'ticket_search_remote',
      `text=${args.text}`,
      'You have no projects with a connected Jira, Linear, Trello or GitHub source.',
    )
  }

  const outcome = await searchRemoteTickets(context.prisma, {
    organizationId: member.organizationId,
    projectIds,
    text: args.text,
    ...(args.limit === undefined ? {} : { limit: args.limit }),
    encryptionSecret: context.boardSourceEncryptionSecret,
  })

  // The basis is every project a match actually came from — a remote item is
  // still that project's work, and the reply quoting it is that project's read.
  for (const projectId of new Set(outcome.matches.map((match) => match.projectId))) {
    recordProjectRead(context, member, projectId)
  }

  const lines = outcome.matches.length
    ? [
        `Provider results (${outcome.matches.length})`,
        ...outcome.matches.map((match) =>
          [
            `- ${match.externalKey} ${match.title} | ${match.provider}: ${match.sourceName}`,
            `  state=${match.stateName} assignee=${match.assigneeDisplayName ?? 'unassigned'}` +
              ` updated=${match.updatedAt}`,
            match.taskId
              ? `  mirrored in Nessie as ticketId=${match.taskId}`
              : `  not mirrored in Nessie; open it at ${match.externalUrl}`,
          ].join('\n'),
        ),
      ]
    : ['No provider results.']

  // A partial answer must never read as a complete one.
  if (outcome.unavailable.length > 0) {
    lines.push(
      `Could not ask ${outcome.unavailable.length} source(s):`,
      ...outcome.unavailable.map((source) => `- ${source.sourceName}: ${source.reason}`),
    )
  }
  return result('ticket_search_remote', `text=${args.text}`, lines.join('\n'))
}
