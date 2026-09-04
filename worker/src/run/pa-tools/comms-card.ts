import { Prisma } from '@prisma/client'
import { parseEmailAccountToolArgs } from '@nessie/runtime'
import { parseChannelId, parseThreadId } from '@nessie/schemas'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember } from './access.js'
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

const postConnectCard = async (
  context: BuiltinToolRuntimeContext,
  input: {
    card: Record<string, unknown>
    content: string
    inputSummary: string
    toolName: string
  },
): Promise<ToolExecutionResult> => {
  const threadId = context.run.threadId
  const thread = await context.prisma.thread.findUnique({
    where: { id: threadId },
    select: { channel: { select: { id: true, systemChannelType: true } } },
  })
  if (!thread) {
    throw new Error('Unable to resolve the current thread.')
  }

  const message = await context.prisma.message.create({
    data: {
      content: input.content,
      role: 'assistant',
      agentId: context.agentId,
      threadId: parseThreadId(threadId),
      metadata: { card: input.card } as Prisma.InputJsonValue,
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
        contentPreview: input.content.slice(0, 200),
        messageId: message.id,
        role: 'assistant',
        threadId: parseThreadId(threadId),
      },
      event: 'message.new',
    },
  )

  return {
    inputSummary: input.inputSummary,
    outputPreview: `Presented the secure connection form; messageId=${message.id}.`,
    toolName: input.toolName,
  }
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
  const content =
    'Connect your communication accounts so I can help across your messages.'
  return postConnectCard(context, {
    card: { kind: 'comms_connect', providers },
    content,
    inputSummary: `providers=${providers.join(',')}`,
    toolName: 'comms_connect_card',
  })
}

/** The one chat doorway into the same address-first email form as Settings. */
export const runEmailAccountConnectTool = async (
  context: BuiltinToolRuntimeContext,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const parsed = parseEmailAccountToolArgs('email_account_connect', args)
  const scope = parsed.scope === 'team' ? 'team' : 'user'
  const member = await resolveActingMember(context)
  if (scope === 'team' && member.role !== 'owner' && member.role !== 'admin') {
    throw new Error('Only an owner or admin can connect a shared mailbox for a team.')
  }
  return postConnectCard(context, {
    card: { kind: 'email_account_connect', scope },
    content: scope === 'team'
      ? 'Connect a shared team email account securely.'
      : 'Connect an email account securely.',
    inputSummary: `scope=${scope}`,
    toolName: 'email_account_connect',
  })
}
