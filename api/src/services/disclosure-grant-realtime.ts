import type { PrismaClient } from '@prisma/client'
import { parseThreadId, type WsScope } from '@nessie/schemas'

import type { RealtimeHub } from '../routes/types.js'

type BuildChannelRealtimeScopes = (input: {
  channelId: string
  organizationId: string
  systemChannelType?: string | null
  visibility?: string
}) => WsScope[]

/**
 * A grant changes only a reader's entitlement, so announce its ids and let the
 * regular message query perform the newly-authorized read. The reply itself
 * never crosses this channel-wide wire event.
 */
export const publishMessageDisclosureChanged = async (input: {
  buildChannelRealtimeScopes: BuildChannelRealtimeScopes
  messageId: string
  prisma: PrismaClient
  realtimeHub: Pick<RealtimeHub, 'publishWs'>
}): Promise<void> => {
  const message = await input.prisma.message.findUnique({
    where: { id: input.messageId },
    select: {
      thread: {
        select: {
          channel: {
            select: {
              id: true,
              organizationId: true,
              systemChannelType: true,
              visibility: true,
            },
          },
          id: true,
        },
      },
    },
  })
  if (!message) return

  const { channel } = message.thread
  await input.realtimeHub.publishWs(
    input.buildChannelRealtimeScopes({
      channelId: channel.id,
      organizationId: channel.organizationId,
      systemChannelType: channel.systemChannelType,
      visibility: channel.visibility,
    }),
    {
      data: {
        messageId: input.messageId,
        threadId: parseThreadId(message.thread.id),
      },
      event: 'message.disclosure.changed',
    },
  )
}
