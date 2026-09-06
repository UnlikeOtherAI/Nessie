import type { PrismaClient } from '@prisma/client'
import type { BoardWatcherRecord } from '@nessie/schemas'

import { resolveAgentConversation } from './agent-conversation.js'

/**
 * Who to tell when a ticket on a board changes.
 *
 * A watcher costs somebody else's attention, so adding one is board
 * administration and every recipient is checked against what the *board's*
 * organisation can actually reach: a user must be an active member, and an
 * agent must exist in the same organisation. A row naming a recipient the
 * server would not accept is refused here rather than discovered later by a
 * fan-out with nowhere to deliver.
 *
 * Removal is deliberately not symmetrical with addition — see
 * `removeSelfAsWatcher`.
 */

/**
 * A recipient as this layer needs it. Deliberately unbranded: the branded ids
 * are the API boundary's business, and a store that demands them makes every
 * internal caller mint a brand it has no way to check.
 */
export type BoardWatcherInput = { kind: 'user' | 'agent'; id: string }

/**
 * The adder's session, captured so a wake can replay it.
 *
 * A wake has no session of its own. Both halves matter: `teamId` decides which
 * DM the agent is woken in (the key includes it, and the interactive route
 * takes it from the session), and `uoaIdentity` is what the Ledger signer
 * verifies — a trigger captures the same thing as its `launchOrigin`, for the
 * same reason.
 */
export type BoardWatcherOrigin = {
  teamId: string
  uoaIdentity?: unknown
}

export type BoardWatcherError =
  | { error: 'BOARD_NOT_FOUND' }
  | { error: 'RECIPIENT_NOT_REACHABLE'; recipientId: string }
  | { error: 'AGENT_HAS_NO_CONVERSATION'; recipientId: string }

export const isBoardWatcherError = <T>(
  value: T | BoardWatcherError,
): value is BoardWatcherError =>
  typeof value === 'object' && value !== null && 'error' in value

const toRecord = (row: {
  id: string
  boardId: string
  userId: string | null
  agentId: string | null
  addedByUserId: string
  createdAt: Date
  user: { displayName: string } | null
  agent: { name: string } | null
}): BoardWatcherRecord => ({
  id: row.id,
  boardId: row.boardId,
  kind: row.userId ? 'user' : 'agent',
  recipientId: (row.userId ?? row.agentId) as string,
  displayName: row.user?.displayName ?? row.agent?.name ?? 'Unknown',
  addedByUserId: row.addedByUserId as BoardWatcherRecord['addedByUserId'],
  createdAt: row.createdAt.toISOString(),
})

const WATCHER_INCLUDE = {
  user: { select: { displayName: true } },
  agent: { select: { name: true } },
} as const

export const listBoardWatchers = async (
  prisma: PrismaClient,
  boardId: string,
): Promise<BoardWatcherRecord[]> => {
  const rows = await prisma.boardWatcher.findMany({
    where: { boardId },
    include: WATCHER_INCLUDE,
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
    origin: BoardWatcherOrigin
    watchers: BoardWatcherInput[]
  },
): Promise<BoardWatcherRecord[] | BoardWatcherError> => {
  const board = await prisma.board.findFirst({
    where: { id: input.boardId, organizationId: input.organizationId },
    select: { id: true },
  })
  if (!board) return { error: 'BOARD_NOT_FOUND' }

  const userIds = input.watchers.filter((w) => w.kind === 'user').map((w) => w.id)
  const agentIds = input.watchers.filter((w) => w.kind === 'agent').map((w) => w.id)
  const agentTargets = new Map<string, { channelId: string; threadId: string }>()

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

  if (agentIds.length > 0) {
    const reachable = await prisma.agent.findMany({
      where: { id: { in: agentIds }, organizationId: input.organizationId },
      select: { id: true },
    })
    const found = new Set(reachable.map((row) => row.id))
    const missing = agentIds.find((id) => !found.has(id))
    if (missing) return { error: 'RECIPIENT_NOT_REACHABLE', recipientId: missing }

    // An agent is *woken* rather than told, and a wake needs a conversation it
    // is bound to. A system agent and the personal assistant have none they
    // could be woken in — they own no automation at all — so accepting one
    // would be a watcher that silently never fires. Resolved here, where a
    // person is still looking at the picker, and stored: the worker must not
    // work out the destination a second time (see `channelId` on the row).
    for (const agentId of agentIds) {
      const conversation = await resolveAgentConversation(prisma, {
        agentId,
        organizationId: input.organizationId,
        onBehalfOfUserId: input.addedByUserId,
        teamId: input.origin.teamId,
      })
      if (!conversation) {
        return { error: 'AGENT_HAS_NO_CONVERSATION', recipientId: agentId }
      }
      agentTargets.set(agentId, conversation)
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.boardWatcher.deleteMany({ where: { boardId: input.boardId } })
    if (input.watchers.length === 0) return
    await tx.boardWatcher.createMany({
      data: input.watchers.map((watcher) => ({
        boardId: input.boardId,
        organizationId: input.organizationId,
        addedByUserId: input.addedByUserId,
        ...(watcher.kind === 'user'
          ? { userId: watcher.id }
          : {
              agentId: watcher.id,
              channelId: agentTargets.get(watcher.id)?.channelId ?? null,
              threadId: agentTargets.get(watcher.id)?.threadId ?? null,
              launchOrigin: {
                teamId: input.origin.teamId,
                userId: input.addedByUserId,
                ...(input.origin.uoaIdentity
                  ? { uoaIdentity: input.origin.uoaIdentity }
                  : {}),
              } as object,
            }),
      })),
    })
  })

  return listBoardWatchers(prisma, input.boardId)
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
