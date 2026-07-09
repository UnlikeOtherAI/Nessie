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
}

export type PersonalAssistantIntegrationHandoffInput = {
  actorContext: UserActorContext
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

  await ensurePersonalAssistantBootstrap(deps.prisma, {
    organizationId: actorContext.tenant.organizationId,
    teamId,
    userId: actorContext.actor.actorId,
  })
  const paState = await deps.loadPersonalAssistantState(actorContext)
  if (!paState?.agent || !paState.channel || !paState.thread) {
    throw new Error('Personal Assistant is unavailable')
  }

  const agent = await deps.prisma.agent.findUnique({
    where: { id: paState.agent.id },
    select: { id: true, name: true, role: true, systemPrompt: true },
  })
  if (!agent) {
    throw new Error('Personal Assistant agent is unavailable')
  }
  const resolvedMetadata =
    typeof input.metadata === 'function'
      ? input.metadata({ channelId: paState.channel.id })
      : input.metadata

  const message = await deps.prisma.message.create({
    data: {
      content,
      metadata: resolvedMetadata as Prisma.InputJsonValue,
      role: 'user',
      threadId: paState.thread.id,
      userId: actorContext.actor.actorId,
    },
    include: messageInclude,
  })

  await deps.realtimeHub.publishWs(
    deps.buildChannelRealtimeScopes({
      channelId: paState.channel.id,
      organizationId: actorContext.tenant.organizationId,
      systemChannelType: paState.channel.systemChannelType,
    }),
    {
      data: {
        agentId: undefined,
        authorUserId: parseUserId(actorContext.actor.actorId),
        channelId: parseChannelId(paState.channel.id),
        contentPreview: content.slice(0, 200),
        messageId: message.id,
        role: message.role,
        threadId: parseThreadId(paState.thread.id),
      },
      event: 'message.new',
    },
  )

  const orchestrationActorContext = deps.isPersonalAssistantChannelType(
    paState.channel.systemChannelType,
  )
    ? withActionContext(actorContext, {
        effectiveUserId: parseUserId(actorContext.actor.actorId),
      })
    : actorContext

  await enqueueOrchestrateDecide(
    deps.prisma,
    {
      actorContext: orchestrationActorContext,
      channelAgents: [agent],
      channelId: parseChannelId(paState.channel.id),
      content,
      messageId: message.id,
      role: message.role,
      threadId: parseThreadId(paState.thread.id),
    },
    input.idempotencyKey ?? `orchestrate:${message.id}`,
  )

  return {
    channel: ChannelRecordSchema.parse(paState.channel),
    message: mapMessageRecord(message),
    thread: ThreadRecordSchema.parse(paState.thread),
  }
}
