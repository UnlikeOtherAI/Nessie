import type { PrismaClient } from '@prisma/client'

import { BoardFilterSchema, DEFAULT_BOARD_FILTER, type BoardFilter } from '@nessie/schemas'

import { boardFilterWhere, boardTaskPoolWhere } from './board-placement.js'
import { isProjectAccessibleToUser } from './project-structure.js'

const readFilter = (value: unknown): BoardFilter => {
  const parsed = BoardFilterSchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_BOARD_FILTER
}

/**
 * Telling a board's watchers that a ticket moved.
 *
 * Three rules decide who hears anything, and each exists because of a way this
 * gets loud or leaks:
 *
 * 1. **A first sync tells nobody.** Every row of an initial sync is a `created`
 *    (`board-source-apply.ts`: `existing ? 'updated' : 'created'`), so
 *    connecting a real Linear team is hundreds of creates in one run — 543 on
 *    the board this was written against. Nobody asked to be told that a board
 *    they just connected has tickets on it.
 * 2. **A sweep summarises; a webhook tells you per ticket.** The two callers are
 *    different questions: a webhook is "this one changed just now", a sweep is
 *    reconciliation and may carry a backlog after an outage.
 * 3. **A recipient who cannot read the task is dropped before anything is
 *    written.** The alert row, the message and the push all exist before any
 *    renderer runs, and a push lands on a lock screen — so refusing at render
 *    time would still have leaked the title. This is the check
 *    `docs/standards/disclosure-boundaries.md` asks for, at the write.
 */

export type BoardWatchChange = 'status' | 'assignee'

export type BoardWatchEvent = {
  taskId: string
  projectId: string
  organizationId: string
  /** Every notification is claimed on this, so two deliveries are one telling. */
  fingerprint: string
  changes: BoardWatchChange[]
}

export type BoardWatchRecipient =
  | { kind: 'user'; userId: string; boardId: string; taskIds: string[] }
  | {
      kind: 'agent'
      agentId: string
      boardId: string
      taskIds: string[]
      /**
       * The administrator who put this agent on the watch list. A shared agent
       * is woken in its DM with them, because that is the conversation their
       * choice created — and it keeps the run attributable to a person.
       */
      addedByUserId: string
      /** Resolved when the watcher was added; null on a row that predates it. */
      channelId: string | null
      threadId: string | null
      /** The adder's captured session, replayed so the run can sign. */
      launchOrigin: unknown
    }

/**
 * Which boards in this project both contain the task and are watched.
 *
 * A board is a view, so a task the board's own filter hides is not on that
 * board and its watchers hear nothing about it.
 */
const watchedBoardsShowingTask = async (
  prisma: PrismaClient,
  event: { taskId: string; projectId: string },
): Promise<string[]> => {
  const boards = await prisma.board.findMany({
    where: {
      projectId: event.projectId,
      watchers: { some: {} },
    },
    select: { id: true, isDefault: true, filter: true },
  })
  if (boards.length === 0) return []

  const showing: string[] = []
  for (const board of boards) {
    const match = await prisma.task.count({
      where: {
        id: event.taskId,
        projectId: event.projectId,
        AND: [
          boardTaskPoolWhere({ id: board.id, isDefault: board.isDefault }),
          boardFilterWhere(readFilter(board.filter)),
        ],
      },
    })
    if (match > 0) showing.push(board.id)
  }
  return showing
}

/**
 * Claim the telling. Returns false when this exact change has already been
 * claimed — a sweep page and a webhook can both apply one change and both
 * arrive here, because the notify happens after the apply transaction commits
 * and nothing else keys on it.
 */
export const claimBoardWatchNotification = async (
  prisma: PrismaClient,
  event: { taskId: string; fingerprint: string },
): Promise<boolean> => {
  try {
    await prisma.boardWatchNotification.create({
      data: { taskId: event.taskId, fingerprint: event.fingerprint },
    })
    return true
  } catch {
    // The unique key rejected it: somebody else is already telling this story.
    return false
  }
}

/**
 * Resolve who to tell, entitlement-filtered, collapsed to one entry per
 * recipient however many watched boards show the task.
 */
export const resolveBoardWatchRecipients = async (
  prisma: PrismaClient,
  events: BoardWatchEvent[],
): Promise<BoardWatchRecipient[]> => {
  if (events.length === 0) return []
  const organizationId = events[0]!.organizationId

  const byUser = new Map<string, { boardId: string; taskIds: Set<string> }>()
  const byAgent = new Map<
    string,
    {
      boardId: string
      taskIds: Set<string>
      addedByUserId: string
      channelId: string | null
      threadId: string | null
      launchOrigin: unknown
    }
  >()

  for (const event of events) {
    const boardIds = await watchedBoardsShowingTask(prisma, event)
    if (boardIds.length === 0) continue
    const watchers = await prisma.boardWatcher.findMany({
      where: { boardId: { in: boardIds } },
      select: {
        boardId: true,
        userId: true,
        agentId: true,
        addedByUserId: true,
        channelId: true,
        threadId: true,
        launchOrigin: true,
      },
    })
    for (const watcher of watchers) {
      if (watcher.userId) {
        const existing = byUser.get(watcher.userId)
        if (existing) existing.taskIds.add(event.taskId)
        else byUser.set(watcher.userId, { boardId: watcher.boardId, taskIds: new Set([event.taskId]) })
      }
      if (watcher.agentId) {
        const existing = byAgent.get(watcher.agentId)
        if (existing) existing.taskIds.add(event.taskId)
        else {
          byAgent.set(watcher.agentId, {
            addedByUserId: watcher.addedByUserId,
            boardId: watcher.boardId,
            channelId: watcher.channelId,
            launchOrigin: watcher.launchOrigin,
            taskIds: new Set([event.taskId]),
            threadId: watcher.threadId,
          })
        }
      }
    }
  }

  const projectId = events[0]!.projectId
  const recipients: BoardWatchRecipient[] = []

  for (const [userId, entry] of byUser) {
    // Rule 3: entitlement before any write. An organisation owner reads every
    // project; anybody else needs a membership.
    const isOwner = await prisma.organizationMember.count({
      where: { organizationId, userId, role: 'owner', deactivatedAt: null },
    }) > 0
    const allowed = await isProjectAccessibleToUser(
      prisma,
      { isOwner, organizationId, userId },
      projectId,
    )
    if (!allowed) continue
    recipients.push({ kind: 'user', userId, boardId: entry.boardId, taskIds: [...entry.taskIds] })
  }

  for (const [agentId, entry] of byAgent) {
    // An agent reads what its own project reads; a deleted agent has already
    // taken its watcher row with it (ON DELETE CASCADE).
    const agent = await prisma.agent.count({ where: { id: agentId, organizationId } })
    if (agent === 0) continue
    // The person who reads this agent's DM must be entitled to the task, for
    // the same reason a user recipient must: the kickoff carries ticket titles
    // into a conversation a human opens, and the run's replies land there too.
    // The user branch above already learned this; the agent branch is the same
    // rule applied to whoever is on the other side of the agent.
    const readerAllowed = await isProjectAccessibleToUser(
      prisma,
      {
        isOwner: await prisma.organizationMember.count({
          where: {
            organizationId,
            userId: entry.addedByUserId,
            role: 'owner',
            deactivatedAt: null,
          },
        }) > 0,
        organizationId,
        userId: entry.addedByUserId,
      },
      projectId,
    )
    if (!readerAllowed) continue

    recipients.push({
      kind: 'agent',
      agentId,
      addedByUserId: entry.addedByUserId,
      boardId: entry.boardId,
      channelId: entry.channelId,
      launchOrigin: entry.launchOrigin,
      taskIds: [...entry.taskIds],
      threadId: entry.threadId,
    })
  }

  return recipients
}
