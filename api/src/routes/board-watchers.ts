import type { FastifyInstance } from 'fastify'

import {
  BoardWatcherRecordSchema,
  SetBoardWatchersBodySchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import {
  isBoardWatcherError,
  listBoardWatchers,
  removeSelfAsWatcher,
  setBoardWatchers,
} from '@nessie/team-admin'

import { createApiResponse, parseInput, sendApiError } from '../lib/api.js'
import type { RouteDeps } from './types.js'

/**
 * Who hears that a ticket on this board moved.
 *
 * Its own file rather than more of `boards.ts`, which is already near the line
 * cap and answers a different question — what a board *is*, as against who is
 * told about it.
 *
 * Reads follow project access; setting the list is board administration, for
 * the same reason columns and sources are: it spends other people's attention.
 * Taking *yourself* off is the one write that is not administrative.
 */
export const registerBoardWatcherRoutes = (
  app: FastifyInstance,
  deps: RouteDeps,
): void => {
  const { prisma, requireActorContext, requireUserActor, requireProjectAdmin, isProjectAccessibleToActor } = deps

  const loadBoard = async (
    actorContext: AuthorizedActionContext,
    projectId: string,
    boardId: string,
  ) => {
    if (!(await isProjectAccessibleToActor(actorContext, projectId))) return null
    return prisma.board.findFirst({
      where: {
        id: boardId,
        projectId,
        organizationId: actorContext.tenant.organizationId,
      },
      select: { id: true, organizationId: true },
    })
  }

  app.get('/api/projects/:projectId/boards/:boardId/watchers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    const { projectId, boardId } = request.params as { projectId: string; boardId: string }
    const board = await loadBoard(actorContext, projectId, boardId)
    if (!board) {
      sendApiError(reply, 404, 'BOARD_NOT_FOUND', 'Board not found')
      return reply
    }
    return createApiResponse(
      BoardWatcherRecordSchema.array().parse(await listBoardWatchers(prisma, board.id)),
    )
  })

  app.put('/api/projects/:projectId/boards/:boardId/watchers', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const { projectId, boardId } = request.params as { projectId: string; boardId: string }
    const board = await loadBoard(actorContext, projectId, boardId)
    if (!board) {
      sendApiError(reply, 404, 'BOARD_NOT_FOUND', 'Board not found')
      return reply
    }
    if (!(await requireProjectAdmin(actorContext, projectId, reply))) return reply
    const body = parseInput(SetBoardWatchersBodySchema, request.body, reply)
    if (!body) return reply

    const teamId = actorContext.tenant.teamId ?? actorContext.actionContext.teamId
    if (!teamId) {
      sendApiError(reply, 400, 'TEAM_REQUIRED', 'A team is required to add a watcher.')
      return reply
    }
    const result = await setBoardWatchers(prisma, {
      boardId: board.id,
      organizationId: board.organizationId,
      addedByUserId: actorContext.actor.actorId,
      // The session is captured here because a wake has no session of its own —
      // the same reason a trigger captures its launch origin.
      origin: {
        teamId,
        ...(actorContext.actionContext.uoaIdentity
          ? { uoaIdentity: actorContext.actionContext.uoaIdentity }
          : {}),
      },
      watchers: body.watchers,
    })
    if (isBoardWatcherError(result)) {
      if (result.error === 'BOARD_NOT_FOUND') {
        sendApiError(reply, 404, 'BOARD_NOT_FOUND', 'Board not found')
        return reply
      }
      if (result.error === 'AGENT_HAS_NO_CONVERSATION') {
        sendApiError(
          reply,
          400,
          'AGENT_HAS_NO_CONVERSATION',
          'That agent has no conversation it can be woken in, so it could never be told.',
        )
        return reply
      }
      sendApiError(
        reply,
        400,
        'RECIPIENT_NOT_REACHABLE',
        'One of those recipients is not in this organisation.',
      )
      return reply
    }
    return createApiResponse(BoardWatcherRecordSchema.array().parse(result))
  })

  /**
   * Stop telling me. Needs project access, not project administration: being
   * added spent this person's attention, and taking it back is theirs to do.
   */
  app.delete('/api/projects/:projectId/boards/:boardId/watchers/me', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const { projectId, boardId } = request.params as { projectId: string; boardId: string }
    const board = await loadBoard(actorContext, projectId, boardId)
    if (!board) {
      sendApiError(reply, 404, 'BOARD_NOT_FOUND', 'Board not found')
      return reply
    }
    const result = await removeSelfAsWatcher(prisma, {
      boardId: board.id,
      organizationId: board.organizationId,
      userId: actorContext.actor.actorId,
    })
    return createApiResponse(result)
  })
}
