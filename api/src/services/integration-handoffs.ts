import { Prisma, type PrismaClient } from '@prisma/client'
import {
  parseAgentId,
  parseChannelId,
  parseRunId,
  parseTaskId,
  parseThreadId,
  parseUserId,
  withActionContext,
  type AuthorizedActionContext,
  type WsScope,
} from '@nessie/schemas'

import type { createRealtimeHub } from '../realtime/hub.js'
import { ChannelRecordSchema } from '../contracts/team.js'
import { ThreadRecordSchema } from '../contracts/messaging.js'
import { enqueueRunExecution } from '@nessie/db'
import { publishMessageNew } from './message-delivery.js'
import { mapMessageRecord } from './message-read-model.js'
import { createSystemAuthoredMessage } from '@nessie/team-admin'
import { ensurePersonalAssistantBootstrap } from './personal-assistant.js'

type UserActorContext = AuthorizedActionContext & {
  actor: AuthorizedActionContext['actor'] & { actorType: 'user' }
}

type PersonalAssistantStateLoader = (
  actorContext: UserActorContext,
) => Promise<{
  agent: { id: string } | null
  channel: {
    id: string
    organizationId: string
    systemChannelType?: string | null
  } | null
  thread?: { id: string } | null
} | null>

type IntegrationHandoffDeps = {
  buildChannelRealtimeScopes: (input: {
    channelId: string
    organizationId: string
    systemChannelType?: string | null
  }) => WsScope[]
  isPersonalAssistantChannelType: (
    value: string | null | undefined,
  ) => value is 'personal_assistant'
  loadPersonalAssistantState: PersonalAssistantStateLoader
  prisma: PrismaClient
  realtimeHub: Awaited<ReturnType<typeof createRealtimeHub>>
  ensureBootstrap?: typeof ensurePersonalAssistantBootstrap
  enqueue?: typeof enqueueRunExecution
}

export type PersonalAssistantIntegrationHandoffInput = {
  actorContext: UserActorContext
  beforeEnqueue?: (
    tx: Prisma.TransactionClient,
    context: {
      channelId: string
      messageId: string
      threadId: string
    },
  ) => Promise<void>
  content: string
  metadata: Record<string, unknown> | ((context: { channelId: string }) => Record<string, unknown>)
  teamId: string
}

export const createPersonalAssistantIntegrationHandoff = async (
  deps: IntegrationHandoffDeps,
  input: PersonalAssistantIntegrationHandoffInput,
) => {
  const { actorContext, content, teamId } = input

  await (deps.ensureBootstrap ?? ensurePersonalAssistantBootstrap)(deps.prisma, {
    organizationId: actorContext.tenant.organizationId,
    teamId,
    userId: actorContext.actor.actorId,
  })
  const paState = await deps.loadPersonalAssistantState(actorContext)
  if (!paState?.agent || !paState.channel || !paState.thread) {
    throw new Error('Personal Assistant is unavailable')
  }
  const channelState = paState.channel
  const threadState = paState.thread

  const agent = await deps.prisma.agent.findUnique({
    where: { id: paState.agent.id },
    select: { id: true },
  })
  if (!agent) {
    throw new Error('Personal Assistant agent is unavailable')
  }
  const resolvedMetadata =
    typeof input.metadata === 'function'
      ? input.metadata({ channelId: channelState.id })
      : input.metadata
  const dispatchActorContext = deps.isPersonalAssistantChannelType(
    channelState.systemChannelType,
  )
    ? withActionContext(actorContext, {
        effectiveUserId: parseUserId(actorContext.actor.actorId),
      })
    : actorContext
  const channel = ChannelRecordSchema.parse(channelState)
  const thread = ThreadRecordSchema.parse(threadState)
  const committed = await deps.prisma.$transaction(async (tx) => {
    const message = await createSystemAuthoredMessage(tx, {
      content,
      // The person asked for this handoff, so they follow the reply thread it
      // starts — the assistant answers into it.
      followedByUserIds: [actorContext.actor.actorId],
      metadata: resolvedMetadata as Prisma.InputJsonValue,
      role: 'user',
      threadId: threadState.id,
      userId: actorContext.actor.actorId,
    })
    // A product handoff prompt is server-authored and never carries files.
    const messageRecord = mapMessageRecord(message, 0)

    await input.beforeEnqueue?.(tx, {
      channelId: channelState.id,
      messageId: message.id,
      threadId: threadState.id,
    })

    const run = await tx.run.create({
      data: {
        agentId: agent.id,
        status: 'pending',
        threadId: threadState.id,
        // Backlink to the handoff message. The cancel handoff-guard reads its
        // `integrationLaunch` metadata to reject cancel with a research_cancel
        // hint (see api/src/services/runs.ts).
        triggerMessageId: message.id,
      },
      select: { agentId: true, id: true, threadId: true },
    })
    const task = await tx.task.create({
      data: {
        agentId: agent.id,
        organizationId: actorContext.tenant.organizationId,
        purpose: content.slice(0, 200),
        runId: run.id,
        status: 'inbox',
      },
      select: { id: true },
    })
    const queued = await (deps.enqueue ?? enqueueRunExecution)(
      tx,
      {
        actorContext: withActionContext(dispatchActorContext, {
          agentId: parseAgentId(run.agentId),
          channelId: parseChannelId(channelState.id),
          taskId: parseTaskId(task.id),
          threadId: parseThreadId(run.threadId),
        }),
        agentId: parseAgentId(run.agentId),
        interactive: true,
        messageId: message.id,
        runId: parseRunId(run.id),
        taskId: parseTaskId(task.id),
        threadId: parseThreadId(run.threadId),
      },
      `run:${message.id}:${agent.id}`,
    )
    if (!queued) {
      throw new Error('Personal Assistant integration handoff is already dispatched')
    }
    return { message, messageRecord }
  })

  try {
    await publishMessageNew(deps, {
      channel: {
        id: channelState.id,
        organizationId: actorContext.tenant.organizationId,
        systemChannelType: channelState.systemChannelType,
      },
      message: committed.message,
      threadId: threadState.id,
    })
  } catch (error) {
    console.error(
      '[integration-handoff] Durable handoff committed but realtime publish failed:',
      error,
    )
  }

  return {
    channel,
    message: committed.messageRecord,
    thread,
  }
}
