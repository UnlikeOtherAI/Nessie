/**
 * W15 — the deterministic channel write (`message_send`).
 *
 * The seam every workflow-authored channel message goes through. Channel and
 * thread are validated against the run's organization INSIDE the caller's
 * transaction (the W28 lesson: a pre-checked target deleted before the insert
 * is a race), and the message is attributed to the workflow's durable actor
 * (the run's `startedByActorType/Id`). Defaults to the installation's channel
 * when the step names none.
 *
 * Authorship mirrors the mailbox path: a user/service starter posts a `user`
 * message as themselves (userId when resolvable); an agent starter posts as
 * that agent. The durable actor id is a service id rather than a user uuid —
 * those rows keep `userId` null, exactly like mailbox actor fallback.
 */

import { Prisma, type PrismaClient } from '@prisma/client'
import { ensureDefaultThread } from './channels.js'

type TransactionClient = Prisma.TransactionClient

export type WorkflowChannelMessageResult = {
  channelId: string
  messageId: string
  threadId: string
}

const WORKFLOW_MESSAGE_TARGET_ERROR =
  'Message target is unavailable for this workflow run.'

// Fixed lock order (channel → thread) matches assertWorkflowAgentTaskTargetInTransaction,
// so a message_send and an agent_task against the same rows cannot deadlock.
export const createWorkflowChannelMessage = async (
  tx: TransactionClient,
  input: {
    actorId: string
    actorType: 'agent' | 'service' | 'user'
    body: string
    channelId?: string
    installationChannelId?: string | null
    organizationId: string
    threadId?: string
    workflowRunId: string
    workflowStepRunId: string
  },
): Promise<WorkflowChannelMessageResult> => {
  const channelId = input.channelId ?? input.installationChannelId ?? null
  if (!channelId) {
    throw new Error('Workflow message_send requires a channelId (or an installation channel).')
  }

  const channels = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM channels
    WHERE id = ${channelId}::uuid
      AND organization_id = ${input.organizationId}::uuid
      AND system_channel_type IS NULL
    FOR UPDATE
  `
  if (channels.length === 0) {
    // Org-generic on purpose: the failure must not confirm or deny whether the
    // channel exists in another organization.
    throw new Error(WORKFLOW_MESSAGE_TARGET_ERROR)
  }

  let threadId = input.threadId
  if (threadId) {
    const threads = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT t.id FROM threads t
      WHERE t.id = ${threadId}::uuid
        AND t.channel_id = ${channelId}::uuid
      FOR UPDATE OF t
    `
    if (threads.length === 0) {
      throw new Error(WORKFLOW_MESSAGE_TARGET_ERROR)
    }
  } else {
    // ensureDefaultThread's reads+create all run against this same tx.
    threadId = await ensureDefaultThread(tx as PrismaClient, channelId)
  }

  // Attribute the durable actor the way the rest of the system does: user
  // starters post as the user, agent starters as the agent. A service starter
  // (an installation id, not a user uuid) posts with no principal.
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.actorId)

  const message = await tx.message.create({
    data: {
      content: input.body,
      role: input.actorType === 'agent' ? 'assistant' : 'user',
      threadId,
      ...(input.actorType === 'user' && isUuid ? { userId: input.actorId } : {}),
      ...(input.actorType === 'agent' && isUuid ? { agentId: input.actorId } : {}),
      metadata: {
        workflow: {
          runId: input.workflowRunId,
          stepRunId: input.workflowStepRunId,
        },
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  })

  return {
    channelId,
    messageId: message.id,
    threadId,
  }
}
