import { Prisma } from '@prisma/client'
import { parseChannelId, parseThreadId } from '@nessie/schemas'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { buildRealtimeScopesForChannel } from './message-destination.js'

const CONNECTABLE_PROVIDERS = ['slack', 'google', 'microsoft'] as const
type ConnectableProvider = (typeof CONNECTABLE_PROVIDERS)[number]

const DEFAULT_PROVIDERS: ConnectableProvider[] = ['slack', 'google']

const normalizeProviders = (value: unknown): ConnectableProvider[] => {
  if (!Array.isArray(value)) return DEFAULT_PROVIDERS
  const selected = value.filter((entry): entry is ConnectableProvider =>
    (CONNECTABLE_PROVIDERS as readonly unknown[]).includes(entry),
  )
  const deduped = [...new Set(selected)]
  return deduped.length > 0 ? deduped : DEFAULT_PROVIDERS
}

/**
 * Thin presentation tool: post a `comms_connect` card into the current thread
 * so the user can link their Slack / Gmail / Microsoft accounts. This carries
 * NO connector logic — the card's buttons drive the authenticated
 * `/api/comms/connections/:provider/start` flow client-side. The PA uses this
 * to offer connection options in-chat.
 */
export const runCommsConnectCardTool = async (
  context: BuiltinToolRuntimeContext,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const providers = normalizeProviders(args.providers)
  const threadId = context.run.threadId

  const thread = await context.prisma.thread.findUnique({
    where: { id: threadId },
    select: { channel: { select: { id: true, systemChannelType: true } } },
  })
  if (!thread) {
    throw new Error('Unable to resolve the current thread.')
  }

  const content =
    'Connect your communication accounts so I can help across your messages.'
  const message = await context.prisma.message.create({
    data: {
      content,
      role: 'assistant',
      agentId: context.agentId,
      threadId: parseThreadId(threadId),
      metadata: {
        card: { kind: 'comms_connect', providers },
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  })

  await context.realtimeTransport.publishWs(
    buildRealtimeScopesForChannel({
      channelId: thread.channel.id,
      organizationId: context.channel.organizationId,
      systemChannelType: thread.channel.systemChannelType,
    }),
    {
      data: {
        agentId: context.agentId,
        channelId: parseChannelId(thread.channel.id),
        contentPreview: content.slice(0, 200),
        messageId: message.id,
        role: 'assistant',
        threadId: parseThreadId(threadId),
      },
      event: 'message.new',
    },
  )

  return {
    inputSummary: `providers=${providers.join(',')}`,
    outputPreview: `Presented a connect card (${providers.join(', ')}); messageId=${message.id}.`,
    toolName: 'comms_connect_card',
  }
}
