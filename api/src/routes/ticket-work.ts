import type { FastifyInstance } from 'fastify'

import {
  BoardTicketWorkRecordSchema,
  isAdminActor,
  TaskTicketWorkRecordSchema,
  TICKET_WORK_REMINDER_READ_ONLY_SENTENCE,
  TicketWorkThreadGateSchema,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import {
  canMemberEditProjectBoards,
  cancelTicketWorkReminder,
  findBoard,
  isUuid,
  loadBoardTicketWork,
  loadTaskTicketWork,
  loadTicketWorkThreadGate,
} from '@nessie/team-admin'

import { createApiResponse, sendApiError } from '../lib/api.js'
import { emitAuditEvent } from '../services/audit.js'
import { getTask } from '../services/tasks.js'
import type { RouteDeps } from './types.js'

/**
 * What the project sees of an agent's ticket work
 * (docs/standards/ticket-work.md → "What the project sees").
 *
 * Every read here is gated by the ticket's, the board's or the thread's own
 * read rule, never by the owner-only Triggers routes: the person who moves a
 * ticket is told what that move did on the ticket itself. Nothing here names
 * a machine.
 */
export const registerTicketWorkRoutes = (app: FastifyInstance, deps: RouteDeps): void => {
  const {
    prisma,
    requireActorContext,
    requireUserActor,
    isProjectAccessibleToActor,
    listAccessibleProjectIds,
  } = deps

  // The same visibility the task routes read a ticket under.
  const taskVisibilityFor = async (actorContext: AuthorizedActionContext) => {
    const accessible = await listAccessibleProjectIds(actorContext)
    return accessible === 'all'
      ? undefined
      : { accessibleProjectIds: accessible, actorUserId: actorContext.actor.actorId }
  }

  /** The chip in the ticket dialog: each trigger's newest work, and the last skip worth saying. */
  app.get('/api/tasks/:taskId/work', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const { taskId } = request.params as { taskId: string }
    const task = await getTask(
      prisma,
      taskId,
      actorContext.tenant.organizationId,
      await taskVisibilityFor(actorContext),
      actorContext.actor.actorId,
      actorContext.actionContext.uoaIdentity,
    )
    if (!task) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
      return reply
    }
    return createApiResponse(TaskTicketWorkRecordSchema.parse(await loadTaskTicketWork(prisma, {
      taskId: task.id,
      organizationId: actorContext.tenant.organizationId,
      viewerUserId: actorContext.actor.actorId,
      // The cancel route below asks the same rule with this request's role.
      isOrganizationAdmin: isAdminActor(actorContext),
    })))
  })

  /**
   * Cancel the agent's pending `check_back_in` on this ticket's live work: the
   * chip's Cancel. Only a person who can edit the board may — the people who
   * can move the ticket and steer its work — asked live, with this request's
   * own role; anyone else who reads the ticket sees the reminder and no door.
   */
  app.delete('/api/tasks/:taskId/work/reminders/:reminderId', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const { taskId, reminderId } = request.params as { taskId: string; reminderId: string }
    const organizationId = actorContext.tenant.organizationId
    const task = await getTask(
      prisma,
      taskId,
      organizationId,
      await taskVisibilityFor(actorContext),
      actorContext.actor.actorId,
      actorContext.actionContext.uoaIdentity,
    )
    if (!task) {
      sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
      return reply
    }
    const editor = task.projectId !== null && await canMemberEditProjectBoards(prisma, {
      organizationId,
      userId: actorContext.actor.actorId,
      projectId: task.projectId,
      isOrganizationAdmin: isAdminActor(actorContext),
    })
    if (!editor) {
      sendApiError(reply, 403, 'TICKET_WORK_REMINDER_READ_ONLY', TICKET_WORK_REMINDER_READ_ONLY_SENTENCE)
      return reply
    }
    const cancelled = isUuid(reminderId)
      ? await cancelTicketWorkReminder(prisma, { taskId: task.id, reminderId, byUserId: actorContext.actor.actorId })
      : null
    if (!cancelled) {
      sendApiError(reply, 404, 'REMINDER_NOT_FOUND', 'This reminder already fired or was cancelled.')
      return reply
    }
    // A person stopping an agent's scheduled wake is audited like pausing a
    // trigger; the work thread says so in a row of its own.
    await emitAuditEvent(prisma, {
      actorContext,
      action: 'trigger.reminder_cancelled',
      resourceType: 'agent_reminder',
      resourceId: reminderId,
      outcome: 'success',
      metadata: { taskId: task.id, workId: cancelled.workId },
    })
    return createApiResponse({ cancelled: true })
  })

  /** The board's column badges, card dots, and whether its column menu offers "Start work with an agent…". */
  app.get('/api/projects/:projectId/boards/:boardId/ticket-work', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const { projectId, boardId } = request.params as { projectId: string; boardId: string }
    const project = await isProjectAccessibleToActor(actorContext, projectId)
      ? await prisma.project.findFirst({
          where: { id: projectId, organizationId: actorContext.tenant.organizationId, deletedAt: null },
          select: { id: true },
        })
      : null
    const board = project ? await findBoard(prisma, project.id, boardId) : null
    if (!board) {
      sendApiError(reply, 404, 'BOARD_NOT_FOUND', 'Board not found')
      return reply
    }
    return createApiResponse(BoardTicketWorkRecordSchema.parse(await loadBoardTicketWork(prisma, {
      board,
      organizationId: actorContext.tenant.organizationId,
      // The Triggers routes' own gate (`requireOwner`), asked here so the
      // doorway is offered only to people the create would not refuse.
      viewerCanCreateTriggers: actorContext.actor.roles?.includes('owner') === true,
    })))
  })

  /** Whether a thread is a ticket's work thread, and whether the viewer may write in it. */
  app.get('/api/threads/:threadId/ticket-work', async (request, reply) => {
    const actorContext = requireActorContext(request, reply)
    if (!actorContext) return reply
    if (!requireUserActor(actorContext, reply)) return reply
    const { threadId } = request.params as { threadId: string }
    const gate = await loadTicketWorkThreadGate(prisma, {
      threadId,
      organizationId: actorContext.tenant.organizationId,
      userId: actorContext.actor.actorId,
      // The message route's own gate reads this request's verified role too.
      isOrganizationAdmin: isAdminActor(actorContext),
    })
    if (gate === undefined) {
      sendApiError(reply, 404, 'THREAD_NOT_FOUND', 'Thread not found')
      return reply
    }
    return createApiResponse(gate === null ? null : TicketWorkThreadGateSchema.parse(gate))
  })
}
