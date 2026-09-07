import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

import { effectiveUserIdOfActor } from '../pa-tools/access.js'
import { resolveMessageDestination } from '../pa-tools/message-destination.js'
import { judgeExplicitDisclosureShare } from './disclosure-share-judge.js'
import { originalHumanAuthorId } from './private-conversation-lineage.js'
import type { RunContext } from './types.js'

/**
 * A narrowly scoped exception to ordinary disclosure withholding. The model
 * judges the live human request and exact proposed tool content; the database
 * proves that same person authored every private-conversation source. Agent
 * ownership, room membership, automation and replay never mint this flag.
 */
export const maybeAuthorizeDisclosureShare = async (input: {
  args: Record<string, unknown>
  actorContext: AuthorizedActionContext
  context: RunContext
  prisma: PrismaClient
  runUtility?: (prompt: string) => Promise<string | null>
  toolName: string
  triggerMessageId?: string
}): Promise<boolean> => {
  if (input.toolName !== 'send_message' || !input.runUtility) return false
  // A human sentence cannot safely bind an attachment's bytes or identity yet.
  // Keep that richer artifact on the ordinary restricted/card path.
  if (input.args['attachmentIds'] !== undefined) return false
  const sources = input.context.consumedSources.privateConversationSources()
  if (sources.length === 0) return false
  if (sources.some((source) => !source.sourceAuthorUserId)) return false
  const sourceChannels = new Set(sources.map((source) => source.sourceChannelId))
  const channelScopes = input.context.consumedSources.list()
    .filter((scope) => scope.scopeType === 'channel')
  if (channelScopes.some((scope) => !sourceChannels.has(scope.scopeId))) return false
  const request = await input.prisma.message.findFirst({
    where: { id: input.triggerMessageId ?? '', threadId: input.context.run.threadId },
    select: {
      agentId: true,
      content: true,
      metadata: true,
      onBehalfOfUserId: true,
      role: true,
      userId: true,
    },
  })
  // A delegated `send_message` deliberately records its effective person in
  // `userId`, but its prose is still model-authored. Only a raw human turn can
  // ask to export a private conversation; the agent's attribution metadata is
  // structural evidence, not an interpretation of the sentence.
  if (!request) return false
  const requestAuthorId = originalHumanAuthorId(request)
  if (!requestAuthorId) return false
  if (effectiveUserIdOfActor(input.actorContext) !== requestAuthorId) return false
  const authors = new Set(sources.flatMap((source) =>
    source.sourceAuthorUserId ? [source.sourceAuthorUserId] : []))
  if (authors.size !== 1 || !authors.has(requestAuthorId)) return false
  const content = typeof input.args['content'] === 'string' ? input.args['content'] : ''
  let destination: Awaited<ReturnType<typeof resolveMessageDestination>>
  try {
    destination = await resolveMessageDestination({
      actorContext: input.actorContext,
      channel: { organizationId: input.context.channel.organizationId },
      prisma: input.prisma,
      run: { threadId: input.context.run.threadId },
    }, {
      channelId: typeof input.args['channelId'] === 'string' ? input.args['channelId'] : undefined,
      content,
      targetUserId: typeof input.args['targetUserId'] === 'string'
        ? input.args['targetUserId']
        : undefined,
      threadId: typeof input.args['threadId'] === 'string' ? input.args['threadId'] : undefined,
    })
  } catch {
    return false
  }
  return judgeExplicitDisclosureShare({
    proposal: [
      `content: ${content}`,
      `destination: ${destination.channelLabel} (${destination.channelScope})`,
      `destination channel id: ${destination.channelId}`,
      `destination thread id: ${destination.threadId}`,
    ].join('\n'),
    request: request.content,
    runUtility: input.runUtility,
  })
}
