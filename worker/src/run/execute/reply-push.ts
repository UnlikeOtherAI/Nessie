import { enqueueQueueJob } from '@nessie/db'
import type { RunExecuteJobPayload } from '@nessie/schemas'
import type { ExecutionDependencies, RunContext } from './types.js'

const replyRecipientUserId = (payload: RunExecuteJobPayload): string | null => {
  if (payload.interactive !== true) return null
  const actionContext = payload.actorContext?.actionContext
  if (actionContext?.effectiveUserId) {
    return actionContext.effectiveUserId
  }
  return payload.actorContext?.actor?.actorType === 'user'
    ? payload.actorContext.actor.actorId
    : null
}

/**
 * Queue the completion of a live conversational turn for exactly the person
 * who asked it. This intentionally bypasses the normal "members minus author"
 * fan-out: an agent has no user author id, and the requester must not be
 * excluded. The run-scoped idempotency key means a terminalization retry never
 * sends a second notification. The dispatch worker still rechecks live
 * membership, preferences, exact foreground surface, registered devices, and
 * (for a protected reply) disclosure entitlement before sending.
 */
export const enqueueInteractiveReplyPush = async (
  deps: Pick<ExecutionDependencies, 'prisma'>,
  payload: RunExecuteJobPayload,
  context: RunContext,
  message: {
    content: string
    id: string
    /** Restricted replies never place their text in a notification. */
    contentVisibility?: 'full' | 'generic'
  },
): Promise<void> => {
  const recipientUserId = replyRecipientUserId(payload)
  if (!recipientUserId) return

  try {
    await enqueueQueueJob(deps.prisma, {
      idempotencyKey: `push:reply:${context.run.id}`,
      payload: {
        channelId: context.channel.id,
        contentSnippet: message.content.slice(0, 140),
        ...(message.contentVisibility ? { contentVisibility: message.contentVisibility } : {}),
        mentionUserIds: [],
        messageId: message.id,
        organizationId: context.channel.organizationId,
        recipientUserIds: [recipientUserId],
        rootMessageId: context.replyRootMessageId ?? message.id,
        threadId: context.run.threadId,
      },
      topic: 'push.dispatch',
    })
  } catch (error) {
    // A response is already durable and visible in realtime. Retrying the run
    // just to enqueue a notification could duplicate the reply, so leave the
    // queue failure observable and preserve the completed turn.
    console.error('[push] failed to enqueue interactive agent reply', {
      error,
      messageId: message.id,
      runId: context.run.id,
    })
  }
}
