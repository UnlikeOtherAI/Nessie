import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient, TaskPriority, TaskStatus } from '@prisma/client'
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  type PaginationDirection,
  type PaginationMeta,
} from '@nessie/schemas'
import { openOpaqueCursor, sealOpaqueCursor } from '@nessie/runtime'

import { boardTaskPoolWhere } from './board-placement.js'
import { mapProjectTask, projectTaskInclude, type ProjectTaskRecord } from './project-task-records.js'

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
  /** Opaque updated-at keyset cursor for a person-facing result page. */
  cursor?: string
  direction?: PaginationDirection
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

/** One ticket-search page, keyset-ordered by activity time then id. */
export type ProjectTaskSearchPage = {
  data: ProjectTaskRecord[]
  meta: PaginationMeta
}

export type SearchProjectTasksOptions = {
  /** The caller's explicit project entitlement; undefined means all org projects. */
  projectIds?: string[]
  /** Run-derived records pass the caller's canonical disclosure decision here. */
  isReadable: (task: ProjectTaskRecord) => Promise<boolean>
  /** Human paging binds a hidden-candidate continuation to this exact viewer. */
  continuation?: { secret: string; userId: string }
}

export class TicketSearchCursorError extends Error {}

const TICKET_SEARCH_SCAN_LIMIT = 200
const TICKET_SEARCH_CURSOR_PREFIX = 'tsc1.'
const TICKET_SEARCH_CURSOR_KEY_PURPOSE = 'nessie.ticket-search-cursor.v1\0'
const TICKET_SEARCH_CURSOR_TTL_MS = 10 * 60 * 1000

type TicketSearchCursor = {
  createdAt: string
  expiresAt: number
  filterKey: string
  id: string
  organizationId: string
  userId: string
  version: 1
}

const cursorFilterKey = (filters: TicketSearchFilters, projectIds: string[] | undefined): string =>
  createHash('sha256').update(JSON.stringify({
    assigneeAgentId: filters.assigneeAgentId ?? null,
    assigneeUserId: filters.assigneeUserId ?? null,
    boardId: filters.boardId ?? null,
    includeArchived: Boolean(filters.includeArchived),
    limit: Math.min(filters.limit ?? TICKET_SEARCH_LIMIT, TICKET_SEARCH_MAX_LIMIT),
    priority: filters.priority ?? null,
    projectId: filters.projectId ?? null,
    projectIds: projectIds ? [...new Set(projectIds)].sort() : null,
    status: filters.status ?? null,
    text: filters.text?.trim() ?? null,
    unmappedAssignee: filters.unmappedAssignee?.trim() ?? null,
    unassigned: Boolean(filters.unassigned),
  })).digest('base64url')

const parseCursor = (value: unknown): TicketSearchCursor | null => {
  if (!value || typeof value !== 'object') return null
  const cursor = value as Partial<TicketSearchCursor>
  if (
    typeof cursor.createdAt !== 'string'
    || typeof cursor.expiresAt !== 'number'
    || typeof cursor.filterKey !== 'string'
    || typeof cursor.id !== 'string'
    || typeof cursor.organizationId !== 'string'
    || typeof cursor.userId !== 'string'
    || cursor.version !== 1
    || Number.isNaN(new Date(cursor.createdAt).getTime())
    || !Number.isFinite(cursor.expiresAt)
  ) return null
  return cursor as TicketSearchCursor
}

/**
 * Tickets matching every filter given, newest activity first.
 *
 * Every caller supplies project entitlement rather than the generic task-list
 * visibility predicate: projectless, owned, or assigned cross-project tickets
 * have no project board doorway and must not appear in this search. The
 * readable callback runs during the keyset walk, so a restricted run cannot
 * make a short page, an inaccessible title, or a false next-page signal.
 */
export const searchProjectTasks = async (
  prisma: PrismaClient,
  organizationId: string,
  filters: TicketSearchFilters,
  options: SearchProjectTasksOptions,
): Promise<ProjectTaskSearchPage> => {
  if (options.projectIds?.length === 0) {
    return { data: [], meta: { hasMore: false, nextCursor: null, prevCursor: null } }
  }
  const board = filters.boardId
    ? await prisma.board.findFirst({
        where: { id: filters.boardId, organizationId },
        select: { id: true, isDefault: true, projectId: true },
      })
    : null
  if (filters.boardId && !board) {
    return { data: [], meta: { hasMore: false, nextCursor: null, prevCursor: null } }
  }

  const text = filters.text?.trim()
  const unmapped = filters.unmappedAssignee?.trim()
  const filterKey = cursorFilterKey(filters, options.projectIds)
  let cursor = decodeKeysetCursor(filters.cursor)
  if (filters.cursor && options.continuation) {
    try {
      const decoded = parseCursor(openOpaqueCursor({
        keyPurpose: TICKET_SEARCH_CURSOR_KEY_PURPOSE,
        prefix: TICKET_SEARCH_CURSOR_PREFIX,
        secret: options.continuation.secret,
      }, filters.cursor))
      if (
        !decoded
        || decoded.expiresAt < Date.now()
        || decoded.filterKey !== filterKey
        || decoded.organizationId !== organizationId
        || decoded.userId !== options.continuation.userId
      ) throw new TicketSearchCursorError('Invalid task search cursor')
      cursor = { createdAt: new Date(decoded.createdAt), id: decoded.id }
    } catch (error) {
      if (error instanceof TicketSearchCursorError) throw error
      throw new TicketSearchCursorError('Invalid task search cursor')
    }
  }
  if (filters.cursor && !cursor) throw new TicketSearchCursorError('Invalid task search cursor')
  const direction = filters.direction ?? 'forward'
  const limit = Math.min(filters.limit ?? TICKET_SEARCH_LIMIT, TICKET_SEARCH_MAX_LIMIT)
  const compare = direction === 'backward' ? 'gt' : 'lt'
  const order = direction === 'backward' ? 'asc' : 'desc'
  const readable: ProjectTaskRecord[] = []
  let scanCursor = cursor
  let scanned = 0
  let exhausted = false
  let lastScanned: { createdAt: Date; id: string } | undefined

  while (readable.length <= limit && scanned < TICKET_SEARCH_SCAN_LIMIT) {
    const take = Math.min(limit + 1, TICKET_SEARCH_SCAN_LIMIT - scanned)
    const cursorWhere: Prisma.TaskWhereInput | undefined = scanCursor
      ? {
          OR: [
            { updatedAt: { [compare]: scanCursor.createdAt } },
            { updatedAt: scanCursor.createdAt, id: { [compare]: scanCursor.id } },
          ],
        }
      : undefined
    const tasks = await prisma.task.findMany({
      where: {
        organizationId,
        projectId: { not: null },
        // Channel-root projects back standalone/internal conversations. They
        // deliberately have no project-board surface for a human search row.
        project: { channelRoot: false },
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.priority ? { priority: filters.priority } : {}),
        ...(filters.assigneeUserId ? { assigneeUserId: filters.assigneeUserId } : {}),
        ...(filters.assigneeAgentId ? { assigneeAgentId: filters.assigneeAgentId } : {}),
        ...(filters.unassigned
          ? { assigneeUserId: null, assigneeAgentId: null, NOT: { externalLink: UNMAPPED_LINK } }
          : {}),
        ...(filters.includeArchived ? {} : { archivedAt: null }),
        AND: [
          ...(board ? [{ projectId: board.projectId }, boardTaskPoolWhere(board)] : []),
          ...(filters.projectId ? [{ projectId: filters.projectId }] : []),
          ...(options.projectIds ? [{ projectId: { in: options.projectIds } }] : []),
          ...(text ? [textWhere(text)] : []),
          ...(unmapped ? [unmappedWhere(unmapped)] : []),
          ...(cursorWhere ? [cursorWhere] : []),
        ],
      },
      include: projectTaskInclude,
      orderBy: [{ updatedAt: order }, { id: order }],
      take,
    })
    scanned += tasks.length
    if (tasks.length < take) exhausted = true
    const candidates = tasks.map(mapProjectTask)
    const permitted = await Promise.all(candidates.map((task) => options.isReadable(task)))
    for (const [index, task] of candidates.entries()) {
      if (permitted[index]) readable.push(task)
      if (readable.length > limit) break
    }
    if (readable.length > limit || exhausted || tasks.length === 0) break
    const scannedTask = tasks.at(-1)
    if (!scannedTask) break
    lastScanned = { createdAt: scannedTask.updatedAt, id: scannedTask.id }
    scanCursor = lastScanned
  }

  const hasAdjacentReadable = readable.length > limit
  const hasBudgetContinuation = !exhausted && scanned >= TICKET_SEARCH_SCAN_LIMIT
  const data = direction === 'backward'
    ? readable.slice(0, limit).reverse()
    : readable.slice(0, limit)
  const first = data.at(0)
  const last = data.at(-1)
  const cursorFor = (anchor: { createdAt: Date; id: string } | undefined): string | null => {
    if (!anchor) return null
    if (!options.continuation) return encodeKeysetCursor(anchor)
    return sealOpaqueCursor({
      keyPurpose: TICKET_SEARCH_CURSOR_KEY_PURPOSE,
      prefix: TICKET_SEARCH_CURSOR_PREFIX,
      secret: options.continuation.secret,
    }, {
      createdAt: anchor.createdAt.toISOString(),
      expiresAt: Date.now() + TICKET_SEARCH_CURSOR_TTL_MS,
      filterKey,
      id: anchor.id,
      organizationId,
      userId: options.continuation.userId,
      version: 1,
    } satisfies TicketSearchCursor)
  }
  const firstAnchor = first ? { createdAt: new Date(first.updatedAt), id: first.id } : undefined
  const lastAnchor = last ? { createdAt: new Date(last.updatedAt), id: last.id } : undefined
  const nextAnchor = hasAdjacentReadable ? lastAnchor : lastScanned

  return direction === 'backward'
    ? {
        data,
        meta: {
          // With only hidden rows in this bounded backwards walk, anchor the
          // return trip at the last scanned row. A forward query from that
          // private, authenticated boundary rescans the hidden stretch and
          // reaches the visible page without exposing a candidate id.
          // A backwards request always has a known page to return to, even
          // when its preceding candidates were all filtered out.
          hasMore: Boolean(cursor),
          nextCursor: cursor && (last
            ? cursorFor(lastAnchor)
            : hasBudgetContinuation ? cursorFor(lastScanned) : cursorFor(cursor)),
          prevCursor: hasAdjacentReadable
            ? cursorFor(firstAnchor)
            : hasBudgetContinuation ? cursorFor(lastScanned) : null,
        },
      }
    : {
        data,
        meta: {
          hasMore: hasAdjacentReadable || hasBudgetContinuation,
          nextCursor: hasAdjacentReadable || hasBudgetContinuation ? cursorFor(nextAnchor) : null,
          // A budget-limited page can contain only hidden candidates. Its
          // input cursor is still the reverse doorway; without it the generic
          // pager treats the page as stale and strands the search at page 0.
          prevCursor: cursor && (first ? cursorFor(firstAnchor) : cursorFor(cursor)),
        },
      }
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
