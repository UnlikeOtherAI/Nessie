import { Prisma, type PrismaClient } from '@prisma/client'
import {
  parseChannelId,
  parseThreadId,
  parseUserId,
  withActionContext,
  type AuthorizedActionContext,
  type WsScope,
} from '@nessie/schemas'

import type { createRealtimeHub } from '../realtime/hub.js'
import { ChannelRecordSchema, ThreadRecordSchema } from '../contracts.js'
import { enqueueOrchestrateDecide } from '../queue/pgqueue.js'
import { mapMessageRecord, messageInclude } from './messages.js'
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
  enqueue?: typeof enqueueOrchestrateDecide
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
  idempotencyKey?: string
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
    select: { id: true, name: true, role: true, systemPrompt: true },
  })
  if (!agent) {
    throw new Error('Personal Assistant agent is unavailable')
  }
  const resolvedMetadata =
    typeof input.metadata === 'function'
      ? input.metadata({ channelId: channelState.id })
      : input.metadata
  const orchestrationActorContext = deps.isPersonalAssistantChannelType(
    channelState.systemChannelType,
  )
    ? withActionContext(actorContext, {
        effectiveUserId: parseUserId(actorContext.actor.actorId),
      })
    : actorContext
  const channel = ChannelRecordSchema.parse(channelState)
  const thread = ThreadRecordSchema.parse(threadState)
  const committed = await deps.prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        content,
        metadata: resolvedMetadata as Prisma.InputJsonValue,
        role: 'user',
        threadId: threadState.id,
        userId: actorContext.actor.actorId,
      },
      include: messageInclude,
    })
    const messageRecord = mapMessageRecord(message)

    await input.beforeEnqueue?.(tx, {
      channelId: channelState.id,
      messageId: message.id,
      threadId: threadState.id,
    })
    await (deps.enqueue ?? enqueueOrchestrateDecide)(
      tx,
      {
        actorContext: orchestrationActorContext,
        channelAgents: [agent],
        channelId: parseChannelId(channelState.id),
        content,
        messageId: message.id,
        role: message.role,
        threadId: parseThreadId(threadState.id),
      },
      input.idempotencyKey ?? `orchestrate:${message.id}`,
    )
    return { message, messageRecord }
  })

  try {
    await deps.realtimeHub.publishWs(
      deps.buildChannelRealtimeScopes({
        channelId: channelState.id,
        organizationId: actorContext.tenant.organizationId,
        systemChannelType: channelState.systemChannelType,
      }),
      {
        data: {
          agentId: undefined,
          authorUserId: parseUserId(actorContext.actor.actorId),
          channelId: parseChannelId(channelState.id),
          contentPreview: content.slice(0, 200),
          messageId: committed.message.id,
          role: committed.message.role,
          threadId: parseThreadId(threadState.id),
        },
        event: 'message.new',
      },
    )
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
