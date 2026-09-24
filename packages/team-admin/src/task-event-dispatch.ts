import { createHash } from 'node:crypto'

import type { Prisma } from '@prisma/client'
import { enqueueQueueJob } from '@nessie/db'
import {
  isTicketTriggerEventType,
  TRIGGER_TICKET_DISPATCH_TOPIC,
  type TriggerTicketDispatchJobPayload,
} from '@nessie/schemas'

/**
 * The one writer of a `TaskEvent` a ticket trigger can act on.
 *
 * The event and its `trigger.ticket.dispatch` job are written in the same
 * transaction, the way `project-task-attention.ts` enqueues its alert: an
 * event can never commit without a recoverable dispatch, and a rolled-back
 * move leaves no job behind to act on a change that never happened
 * (docs/standards/ticket-work.md).
 *
 * The job is enqueued only when the ticket's project has an enabled
 * `ticket_changed` trigger, found by its indexed `scope_project_id`: an event
 * no trigger could see costs one indexed read and no queue row. Everything
 * else about the decision — which trigger, whether the origin may start or
 * steer work — is the dispatcher's, read afresh when it runs.
 */
export type TaskEventWriter = Pick<Prisma.TransactionClient, 'taskEvent' | 'task' | 'agentTrigger' | '$executeRaw'>

/**
 * The description a `detail_edited` event wrote, as a hash: history never
 * copies the text, but a wake that quotes the description as its author's
 * words must know the ticket still says what that author wrote, and not what
 * a later token, agent or board sync replaced it with. Null for a cleared one.
 */
export const taskDetailSha256 = (detail: string | null): string | null =>
  detail === null ? null : createHash('sha256').update(detail).digest('hex')

/** The ticket's organisation and project, when the caller already holds them. */
export type TaskEventScope = { organizationId: string; projectId: string | null }

export const recordTaskEvent = async (
  tx: TaskEventWriter,
  input: {
    taskId: string
    eventType: string
    payload: Prisma.InputJsonObject
    scope?: TaskEventScope
  },
): Promise<{ id: string }> => {
  const event = await tx.taskEvent.create({
    data: { taskId: input.taskId, eventType: input.eventType, payload: input.payload },
    select: { id: true },
  })
  if (isTicketTriggerEventType(input.eventType)) {
    await enqueueTicketTriggerDispatch(tx, { taskEventId: event.id, taskId: input.taskId, scope: input.scope })
  }
  return event
}

const enqueueTicketTriggerDispatch = async (
  tx: TaskEventWriter,
  input: { taskEventId: string; taskId: string; scope?: TaskEventScope },
): Promise<void> => {
  const scope = input.scope
    ?? await tx.task.findUnique({
      where: { id: input.taskId },
      select: { organizationId: true, projectId: true },
    })
  // A projectless ticket is on no board, so no ticket trigger can see it.
  if (!scope?.projectId) return
  const trigger = await tx.agentTrigger.findFirst({
    where: { type: 'ticket_changed', enabled: true, scopeProjectId: scope.projectId },
    select: { id: true },
  })
  if (!trigger) return
  const payload: TriggerTicketDispatchJobPayload = {
    organizationId: scope.organizationId,
    taskEventId: input.taskEventId,
  }
  await enqueueQueueJob(tx, {
    idempotencyKey: `${TRIGGER_TICKET_DISPATCH_TOPIC}:${input.taskEventId}`,
    payload,
    topic: TRIGGER_TICKET_DISPATCH_TOPIC,
  })
}
