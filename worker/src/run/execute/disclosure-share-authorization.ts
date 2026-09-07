import type { PrismaClient } from '@prisma/client'

import { judgeExplicitDisclosureShare } from './disclosure-share-judge.js'
import type { RunContext } from './types.js'

/**
 * A narrowly scoped exception to ordinary disclosure withholding. The model
 * judges the live human request and exact proposed tool content; the database
 * proves that same person authored every private-conversation source. Agent
 * ownership, room membership, automation and replay never mint this flag.
 */
export const maybeAuthorizeDisclosureShare = async (input: {
  args: Record<string, unknown>
  context: RunContext
  prisma: PrismaClient
  runUtility?: (prompt: string) => Promise<string | null>
  toolName: string
  triggerMessageId?: string
}): Promise<boolean> => {
  if (input.toolName !== 'send_message' || !input.runUtility) return false
  const sources = input.context.consumedSources.privateConversationSources()
  if (sources.length === 0) return false
  if (sources.some((source) => !source.sourceAuthorUserId)) return false
  const sourceChannels = new Set(sources.map((source) => source.sourceChannelId))
  const channelScopes = input.context.consumedSources.list()
    .filter((scope) => scope.scopeType === 'channel')
  if (channelScopes.some((scope) => !sourceChannels.has(scope.scopeId))) return false
  const request = await input.prisma.message.findUnique({
    where: { id: input.triggerMessageId ?? '' },
    select: { content: true, userId: true },
  })
  if (!request?.userId) return false
  const authors = new Set(sources.flatMap((source) =>
    source.sourceAuthorUserId ? [source.sourceAuthorUserId] : []))
  if (authors.size !== 1 || !authors.has(request.userId)) return false
  const content = typeof input.args['content'] === 'string' ? input.args['content'] : ''
  const destination = [input.args['channelId'], input.args['threadId'], input.args['targetUserId']]
    .filter((value): value is string => typeof value === 'string')
    .join(',') || 'the current conversation'
  return judgeExplicitDisclosureShare({
    proposal: `content: ${content}\ndestination: ${destination}`,
    request: request.content,
    runUtility: input.runUtility,
  })
}
