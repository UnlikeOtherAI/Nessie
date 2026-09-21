import type { FastifyReply, FastifyRequest } from 'fastify'

import type { AuthorizedActionContext } from '@nessie/schemas'
import type { TaskActor } from '@nessie/team-admin'

import { sendApiError } from '../lib/api.js'
import { taskActorFromContext } from '../services/task-labels.js'
import { getTask } from '../services/tasks.js'
import type { RouteDeps } from './types.js'

/**
 * The read gate every comment and attachment route shares: a signed-in
 * person, and a task they can read — the same `getTask` the task routes gate
 * on, so a run-derived ticket the viewer may not read is a 404 here too. The
 * shared function the route then calls re-asks the project question itself,
 * because an MCP tool or a worker builtin reaches it without this gate.
 */
export const createTaskActivityGate = (deps: RouteDeps) => async (
  request: FastifyRequest,
  reply: FastifyReply,
  taskId: string,
): Promise<{ actorContext: AuthorizedActionContext; actor: TaskActor } | null> => {
  const actorContext = deps.requireActorContext(request, reply)
  if (!actorContext) return null
  if (!deps.requireUserActor(actorContext, reply)) return null
  const accessible = await deps.listAccessibleProjectIds(actorContext)
  const task = /^[0-9a-f-]{36}$/i.test(taskId)
    ? await getTask(
        deps.prisma,
        taskId,
        actorContext.tenant.organizationId,
        accessible === 'all'
          ? undefined
          : { accessibleProjectIds: accessible, actorUserId: actorContext.actor.actorId },
        actorContext.actor.actorId,
        actorContext.actionContext.uoaIdentity,
      )
    : null
  if (!task) {
    sendApiError(reply, 404, 'NOT_FOUND', 'Task not found')
    return null
  }
  return { actorContext, actor: taskActorFromContext(actorContext) }
}

const MESSAGES: Record<string, [number, string]> = {
  NOT_FOUND: [404, 'Task not found'],
  COMMENT_NOT_FOUND: [404, 'Comment not found'],
  COMMENT_NOT_AUTHOR: [403, 'Only the author can change this comment'],
  COMMENT_NOT_WRITABLE: [409, 'This comment cannot be changed from Nessie'],
  CURSOR_INVALID: [400, 'Invalid comment cursor'],
  ATTACHMENT_NOT_ON_TASK: [404, 'Attachment not found on this task'],
  ATTACHMENT_NOT_REMOVABLE: [403, 'Only the uploader or a project member can remove this file'],
  LABEL_NOT_IN_PROJECT: [400, 'That label is not one of this project\'s labels'],
  LABEL_NOT_IN_PROJECT_SOURCE: [400, 'That label belongs to a different source than this ticket'],
  SOURCE_READ_ONLY: [409, 'That source is read only.'],
  SOURCE_REJECTED: [409, 'The provider refused that change.'],
  ASSIGNEE_NOT_LINKED: [409, 'That assignee is not linked to a provider account.'],
  SOURCE_UNAVAILABLE: [502, 'The provider could not be reached.'],
}

/**
 * Map a shared function's typed refusal to its status. A source refusal keeps
 * the collaborator's own words, which name the remedy. Returns false for a
 * code it does not know, so the caller can answer it.
 */
export const sendTaskActivityError = (
  reply: FastifyReply,
  result: { error: string; detail?: string; labelId?: string },
): boolean => {
  const known = MESSAGES[result.error]
  if (!known) return false
  const field = result.error.startsWith('LABEL_') ? 'labelIds' : undefined
  sendApiError(reply, known[0], result.error, result.detail ?? known[1], field,
    result.labelId ? { labelId: result.labelId } : undefined)
  return true
}
