import type { ChannelRecord } from '../../lib/api-client'

export const upsertChannel = (
  current: ChannelRecord[] | undefined,
  channel: ChannelRecord,
): ChannelRecord[] => {
  if (!current) {
    return [channel]
  }

  const existingIndex = current.findIndex((entry) => entry.id === channel.id)
  if (existingIndex === -1) {
    return [channel, ...current]
  }

  return current.map((entry) => (entry.id === channel.id ? channel : entry))
}
