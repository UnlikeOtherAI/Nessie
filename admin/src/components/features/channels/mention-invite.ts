import type { ChannelRecord, UserRecord } from '../../../lib/api-client'

/**
 * Who a draft addresses, read the way the server reads it.
 *
 * `resolveMessageMentions` (`@nessie/runtime`) treats `@<display name>`
 * followed by a boundary as a mention. The composer uses the same structural
 * rule to find the people a draft names, so the pre-send question is asked
 * about exactly the people the server would alert — no more, no fewer. Whether
 * any of them cannot read the channel is then the server's answer
 * (`GET /api/channels/:channelId/mention-audience`), never decided here.
 */

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const mentionsName = (text: string, name: string): boolean =>
  name.length > 0
  && new RegExp(`@${escapeRegExp(name)}(?:\\s|$|[^\\w])`, 'i').test(text)

/**
 * Every active person in the organisation directory. Deactivated people are
 * only present in an owner's management view, and are never addressable.
 */
export const mentionableUsers = (users: UserRecord[]): UserRecord[] =>
  users.filter((user) => !user.deactivatedAt)

/**
 * A DM's pair is fixed and a system conversation (the Personal Assistant's
 * home) belongs to nobody else, so neither ever asks about an invite.
 */
export const channelMayAskToInvite = (channel: ChannelRecord | null): channel is ChannelRecord =>
  channel !== null && channel.type !== 'dm' && !channel.systemChannelType

/**
 * The people a draft @mentions who are not already known to be in the channel.
 * Known members are skipped only to save a round trip; everyone else goes to
 * the server, which decides.
 */
export const findMentionedNonMemberIds = (
  text: string,
  users: UserRecord[],
  input: { channelId: string; currentUserId: string | undefined },
): string[] => {
  if (!text.includes('@')) return []
  return mentionableUsers(users)
    .filter((user) =>
      user.id !== input.currentUserId
      && !user.channelIds.includes(input.channelId)
      && mentionsName(text, user.displayName))
    .map((user) => user.id)
}
