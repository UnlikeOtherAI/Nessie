import type { AgentConversationChannel } from '@nessie/schemas'

/**
 * How a conversation names the room it lives in, and how old it is.
 *
 * Pure, and shared by the list rows, the panel, the conversation header's
 * eyebrow and the card's footer: four surfaces that must not disagree about
 * whether a thread is in `#design`, in a DM, or in the assistant's own room.
 */

/**
 * The room, in the words the reader already uses for it: `#design` for a
 * channel, the other party's name for a direct message, and the assistant by
 * name for its own DM (whose channel label is an internal one).
 */
export const conversationRoomLabel = (channel: AgentConversationChannel): string => {
  if (channel.systemChannelType === 'personal_assistant') return 'Personal Assistant'
  if (channel.type === 'dm') return channel.label || 'Direct message'
  return `#${channel.label}`
}

/**
 * The room plus the project that owns it — the conversation header's eyebrow.
 * A DM and a standalone channel have no project to name, so they are just the
 * room.
 */
export const conversationRoomEyebrow = (channel: AgentConversationChannel): string => {
  const room = conversationRoomLabel(channel)
  return channel.projectName ? `${room} · ${channel.projectName}` : room
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

/**
 * A list row's trailing age: "now", "4m", "2h", "Tue", "3 Sep".
 *
 * The vocabulary is the one the spec names, and it is deliberately not
 * `formatRelativeAge` (the project dashboard's coarse "now/4h/3d/2w", which
 * never falls back to a date) nor `formatRelativeTime` (the trigger list's
 * "in 5 min" / "3 d ago", which is about a schedule): a conversation list is
 * read like a mail inbox, where anything older than a week wants its date.
 *
 * `null` in, `null` out — a conversation with no activity shows nothing rather
 * than a fabricated age. Built by hand rather than with `Intl.RelativeTimeFormat`
 * because the last two buckets are absolute dates, not relative phrases.
 */
export const formatConversationTime = (
  value: string | null | undefined,
  now: number = Date.now(),
): string | null => {
  if (!value) return null
  const at = new Date(value)
  const ms = at.getTime()
  if (Number.isNaN(ms)) return null

  // A clock skew ahead of us is "now", never a negative age.
  const age = Math.max(0, now - ms)
  if (age < MINUTE_MS) return 'now'
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m`
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h`
  if (age < WEEK_MS) return WEEKDAYS[at.getDay()] ?? null
  return `${at.getDate()} ${MONTHS[at.getMonth()] ?? ''}`.trim()
}
