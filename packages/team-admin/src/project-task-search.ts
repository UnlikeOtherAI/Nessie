import type { Prisma, PrismaClient, TaskPriority, TaskStatus } from '@prisma/client'

import { boardTaskPoolWhere } from './board-placement.js'
import { mapProjectTask, projectTaskInclude, type ProjectTaskRecord } from './project-task-records.js'
import { projectTaskVisibilityWhere, type ProjectTaskVisibility } from './project-tasks.js'

/**
 * Searching the ticket pool — the read behind the assistant's `ticket_search`.
 *
 * Its own module rather than more of `project-tasks.ts`: that file is the
 * ticket *lifecycle* (create, assign, move, transition, archive) and is at the
 * file cap. Finding work is a different responsibility, and it is the one that
 * has to understand people the lifecycle never mentions — the provider users a
 * mirrored item names that Nessie has no account for.
 */

export const TICKET_SEARCH_LIMIT = 50
export const TICKET_SEARCH_MAX_LIMIT = 200

export type TicketSearchFilters = {
  /** Matched against title, purpose, detail and the provider's own key. */
  text?: string
  projectId?: string
  boardId?: string
  status?: TaskStatus
  priority?: TaskPriority
  assigneeUserId?: string
  assigneeAgentId?: string
  /**
   * A provider person no `BoardSourceIdentityLink` resolves, named either by
   * the provider's own id for them or by the display name the card shows.
   * They have no user id, so they cannot be reached through `assigneeUserId`
   * — and before this they could not be searched for at all.
   */
  unmappedAssignee?: string
  /** Nobody at all: no colleague, no agent, and no provider person either. */
  unassigned?: boolean
  includeArchived?: boolean
  limit?: number
}

/**
 * `remoteAssigneeDisplay` is written only when no identity link resolved
 * (`board-source-apply.ts`), so "has a display name" is the durable test for
 * unmapped, and it is the same one the board card and its filter use.
 */
const UNMAPPED_LINK: Prisma.TaskExternalLinkWhereInput = {
  remoteAssigneeDisplay: { not: null },
}

const textWhere = (text: string): Prisma.TaskWhereInput => ({
  OR: [
    { title: { contains: text, mode: 'insensitive' } },
    { purpose: { contains: text, mode: 'insensitive' } },
    { detail: { contains: text, mode: 'insensitive' } },
    // The provider's key is how a person refers to a mirrored ticket out loud
    // ("what happened to ENG-214?"), so it is part of the text a search covers.
    { externalLink: { externalKey: { contains: text, mode: 'insensitive' } } },
  ],
})

const unmappedWhere = (needle: string): Prisma.TaskWhereInput => ({
  externalLink: {
    ...UNMAPPED_LINK,
    OR: [
      { remoteAssigneeExternalId: needle },
      { remoteAssigneeDisplay: { contains: needle, mode: 'insensitive' } },
    ],
  },
})

/**
 * Tickets matching every filter given, newest activity first.
 *
 * Scoped by organisation and then by the caller's own visibility, so this is
 * never a way to read a project the actor cannot open. The text match is a
 * scan rather than a full-text index: it always runs inside one organisation
 * (usually one project), is capped, and the pool a board reads is capped at
 * 500 for the same reason — a person searching tickets is not paging a corpus.
 */
export const searchProjectTasks = async (
  prisma: PrismaClient,
  organizationId: string,
  filters: TicketSearchFilters,
  visibility?: ProjectTaskVisibility,
): Promise<ProjectTaskRecord[]> => {
  const board = filters.boardId
    ? await prisma.board.findFirst({
        where: { id: filters.boardId, organizationId },
        select: { id: true, isDefault: true, projectId: true },
      })
    : null
  if (filters.boardId && !board) return []

  const text = filters.text?.trim()
  const unmapped = filters.unmappedAssignee?.trim()

  const tasks = await prisma.task.findMany({
    where: {
      organizationId,
      ...(text ? textWhere(text) : {}),
      ...(board ? { projectId: board.projectId, ...boardTaskPoolWhere(board) } : {}),
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.priority ? { priority: filters.priority } : {}),
      ...(filters.assigneeUserId ? { assigneeUserId: filters.assigneeUserId } : {}),
      ...(filters.assigneeAgentId ? { assigneeAgentId: filters.assigneeAgentId } : {}),
      ...(unmapped ? unmappedWhere(unmapped) : {}),
      ...(filters.unassigned
        ? {
            assigneeUserId: null,
            assigneeAgentId: null,
            // A card the provider says belongs to somebody is not unassigned
            // just because Nessie cannot resolve who they are.
            NOT: { externalLink: UNMAPPED_LINK },
          }
        : {}),
      ...(filters.includeArchived ? {} : { archivedAt: null }),
      ...projectTaskVisibilityWhere(visibility),
    },
    include: projectTaskInclude,
    orderBy: { updatedAt: 'desc' },
    take: Math.min(filters.limit ?? TICKET_SEARCH_LIMIT, TICKET_SEARCH_MAX_LIMIT),
  })
  return tasks.map(mapProjectTask)
}

/** A provider person holding tickets that no Nessie account answers for. */
export type UnmappedTicketPerson = {
  provider: 'jira' | 'linear' | 'trello' | 'github'
  externalUserId: string | null
  displayName: string
  /** How many tickets in scope they are currently named on. */
  ticketCount: number
}

/**
 * The unmapped people a search can be narrowed to.
 *
 * There is no roster to read: an unmapped person exists only as the assignee
 * of a mirrored ticket, which is exactly what makes them worth listing — an
 * assistant asked "what is Ada working on" has no other way to discover that
 * Ada is a Linear user with no Nessie account. Reading the tickets is also
 * what lets the answer say how much they are holding.
 */
export const listUnmappedTicketPeople = async (
  prisma: PrismaClient,
  organizationId: string,
  options: { projectId?: string } = {},
): Promise<UnmappedTicketPerson[]> => {
  const links = await prisma.taskExternalLink.findMany({
    where: {
      organizationId,
      ...UNMAPPED_LINK,
      ...(options.projectId ? { task: { projectId: options.projectId } } : {}),
      task: { archivedAt: null, ...(options.projectId ? { projectId: options.projectId } : {}) },
    },
    select: {
      remoteAssigneeExternalId: true,
      remoteAssigneeDisplay: true,
      source: { select: { provider: true } },
    },
  })

  const people = new Map<string, UnmappedTicketPerson>()
  for (const link of links) {
    const displayName = link.remoteAssigneeDisplay
    if (!displayName) continue
    const provider = link.source.provider
    // The provider scopes its own ids, so it is part of the identity; the name
    // is only a fallback for a provider that gave us no id.
    const key = `${provider}:${link.remoteAssigneeExternalId ?? displayName}`
    const existing = people.get(key)
    if (existing) existing.ticketCount += 1
    else {
      people.set(key, {
        provider,
        externalUserId: link.remoteAssigneeExternalId,
        displayName,
        ticketCount: 1,
      })
    }
  }
  return [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
}
