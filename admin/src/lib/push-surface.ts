import { ChannelIdSchema, type PushSurface } from '@nessie/schemas'

const UUID_PATH_SEGMENT = '[0-9a-f-]{36}'
const CHANNEL_PATH = new RegExp(
  `^/channels/(${UUID_PATH_SEGMENT})(?:/threads/${UUID_PATH_SEGMENT}/replies/${UUID_PATH_SEGMENT})?/?$`,
  'i',
)

/** Maps only concrete, push-targetable routes to the structured API contract. */
export const resolvePushSurface = (pathname: string): PushSurface | null => {
  const channel = pathname.match(CHANNEL_PATH)
  const channelId = ChannelIdSchema.safeParse(channel?.[1])
  if (channelId.success) {
    return { kind: 'channel', channelId: channelId.data }
  }
  return pathname === '/ops/usage' ? { kind: 'ops_usage' } : null
}
