export type ChannelSlugSource = {
  label: string
  slug?: string | null
  team?: {
    project?: {
      name: string
    } | null
  } | null
}

export const toChannelSlug = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

export const getChannelSlug = (channel: ChannelSlugSource): string =>
  channel.slug ?? toChannelSlug(channel.label)

export const getScopedChannelSlug = (channel: ChannelSlugSource): string => {
  const projectSlug = toChannelSlug(channel.team?.project?.name ?? '')
  const channelSlug = getChannelSlug(channel)
  return projectSlug ? `${projectSlug}/${channelSlug}` : channelSlug
}

export const parseScopedChannelTarget = (
  value: string,
): { channelSlug: string; projectSlug: string } | null => {
  const target = value.trim().replace(/^#/, '')
  const parts = target.split('/').map(toChannelSlug).filter(Boolean)
  if (parts.length < 2) {
    return null
  }
  return {
    channelSlug: parts[parts.length - 1]!,
    projectSlug: parts.slice(0, -1).join('-'),
  }
}
