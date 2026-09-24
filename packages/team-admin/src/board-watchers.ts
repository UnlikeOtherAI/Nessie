import type { PrismaClient } from '@prisma/client'
import type { BoardWatcherRecord } from '@nessie/schemas'

/**
 * Who to tell when a ticket on a board changes.
 *
 * A watcher costs somebody else's attention, so adding one is board
 * administration and every recipient is checked against what the *board's*
 * organisation can actually reach: an active member. A row naming a recipient
 * the server would not accept is refused here rather than discovered later by
 * a fan-out with nowhere to deliver.
 *
 * **Watchers are people.** Agent watchers were a second way to configure the
 * wake a `ticket_changed` trigger is, with a different authority and a wake
 * that landed in the adder's DM with no tools
 * (docs/plans/2026-09-23-ticket-driven-agents/triggers.md → "Board
 * watchers"). An agent recipient is refused with the sentence that says where
 * that moved; the rows that existed became disabled ticket triggers in
 * `20260924000000_board_agent_watchers_to_ticket_triggers`.
 *
 * Removal is deliberately not symmetrical with addition — see
 * `removeSelfAsWatcher`.
 */

/**
 * A recipient as this layer receives it. `agent` is still a kind a request can
 * name, so that one is refused in words rather than as a malformed body.
 * Deliberately unbranded: the branded ids are the API boundary's business.
 */
export type BoardWatcherInput = { kind: 'user' | 'agent'; id: string }

export type BoardWatcherError =
  | { error: 'BOARD_NOT_FOUND' }
  | { error: 'RECIPIENT_NOT_REACHABLE'; recipientId: string }
  | { error: 'AGENT_WATCHERS_RETIRED'; recipientId: string }

/** What an agent recipient is told instead, and what the watcher editor says. */
export const AGENT_WATCHERS_RETIRED_SENTENCE =
  'Agents no longer watch boards. Agents start work from the column menu: '
  + '"Start work with an agent…" on a column sets up a ticket trigger.'

export const isBoardWatcherError = <T>(
  value: T | BoardWatcherError,
): value is BoardWatcherError =>
  typeof value === 'object' && value !== null && 'error' in value

const toRecord = (row: {
  id: string
  boardId: string
  userId: string | null
  addedByUserId: string
  createdAt: Date
  user: { displayName: string } | null
}): BoardWatcherRecord => ({
  id: row.id,
  boardId: row.boardId,
  kind: 'user',
  recipientId: row.userId as string,
  displayName: row.user?.displayName ?? 'Unknown',
  addedByUserId: row.addedByUserId as BoardWatcherRecord['addedByUserId'],
  createdAt: row.createdAt.toISOString(),
})

export const listBoardWatchers = async (
  prisma: PrismaClient,
  input: { boardId: string; organizationId: string; userId: string },
): Promise<BoardWatcherRecord[]> => {
  const rows = await prisma.boardWatcher.findMany({
    where: {
      boardId: input.boardId,
      organizationId: input.organizationId,
      userId: { not: null },
    },
    include: { user: { select: { displayName: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map(toRecord)
}

/**
 * Replace the whole list. A watcher list is short and edited as a document, so
 * a diff would be two orderings of one edit and a merge nobody asked for.
 */
export const setBoardWatchers = async (
  prisma: PrismaClient,
  input: {
    boardId: string
    organizationId: string
    addedByUserId: string
    watchers: BoardWatcherInput[]
  },
): Promise<BoardWatcherRecord[] | BoardWatcherError> => {
  const board = await prisma.board.findFirst({
    where: { id: input.boardId, organizationId: input.organizationId },
    select: { id: true },
  })
  if (!board) return { error: 'BOARD_NOT_FOUND' }

  const agent = input.watchers.find((watcher) => watcher.kind === 'agent')
  if (agent) return { error: 'AGENT_WATCHERS_RETIRED', recipientId: agent.id }

  const userIds = input.watchers.map((watcher) => watcher.id)
  if (userIds.length > 0) {
    const reachable = await prisma.organizationMember.findMany({
      where: {
        organizationId: input.organizationId,
        userId: { in: userIds },
        deactivatedAt: null,
      },
      select: { userId: true },
    })
    const found = new Set(reachable.map((row) => row.userId))
    const missing = userIds.find((id) => !found.has(id))
    if (missing) return { error: 'RECIPIENT_NOT_REACHABLE', recipientId: missing }
  }

  await prisma.$transaction(async (tx) => {
    await tx.boardWatcher.deleteMany({ where: { boardId: input.boardId } })
    if (userIds.length === 0) return
    await tx.boardWatcher.createMany({
      data: userIds.map((userId) => ({
        boardId: input.boardId,
        organizationId: input.organizationId,
        addedByUserId: input.addedByUserId,
        userId,
      })),
    })
  })

  return listBoardWatchers(prisma, {
    boardId: input.boardId,
    organizationId: input.organizationId,
    userId: input.addedByUserId,
  })
}

/**
 * A watcher takes themselves off the list, without being a project
 * administrator.
 *
 * Adding somebody is gated because it spends their attention; making them find
 * an administrator to stop is not the same act and does not deserve the same
 * gate. Removing anybody *else* still does, which is why this only ever deletes
 * a row naming the caller.
 */
export const removeSelfAsWatcher = async (
  prisma: PrismaClient,
  input: { boardId: string; organizationId: string; userId: string },
): Promise<{ removed: boolean }> => {
  const result = await prisma.boardWatcher.deleteMany({
    where: {
      boardId: input.boardId,
      organizationId: input.organizationId,
      userId: input.userId,
    },
  })
  return { removed: result.count > 0 }
}
