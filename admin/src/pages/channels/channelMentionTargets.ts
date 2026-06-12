import type { ChannelRecord } from '../../lib/api-client'

export type ChannelMentionTarget = {
  channel: ChannelRecord
  detail: string
  name: string
}

export const getChannelScopeLabel = (channel: ChannelRecord): string =>
  `${channel.projectName} / ${channel.teamName}`

const normalizeChannelLabel = (label: string): string => label.trim().toLowerCase()

export const buildChannelMentionTargets = (
  channels: ChannelRecord[],
): ChannelMentionTarget[] => {
  const standardChannels = channels.filter((channel) => channel.type !== 'dm')
  const labelCounts = standardChannels.reduce<Map<string, number>>((counts, channel) => {
    const key = normalizeChannelLabel(channel.label)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return counts
  }, new Map())
  const scopedCounts = standardChannels.reduce<Map<string, number>>((counts, channel) => {
    const key = `${normalizeChannelLabel(channel.label)}:${getChannelScopeLabel(channel)}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    return counts
  }, new Map())

  return standardChannels.map((channel) => {
    const scope = getChannelScopeLabel(channel)
    const scopedKey = `${normalizeChannelLabel(channel.label)}:${scope}`
    const duplicateLabel = (labelCounts.get(normalizeChannelLabel(channel.label)) ?? 0) > 1
    const duplicateScope = (scopedCounts.get(scopedKey) ?? 0) > 1
    const detail = duplicateScope ? `${scope} (${channel.id.slice(0, 8)})` : scope
    return {
      channel,
      detail,
      name: duplicateLabel ? `${channel.label} (${detail})` : channel.label,
    }
  })
}
