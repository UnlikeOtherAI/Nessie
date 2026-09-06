import type { ImapPart } from './imap.js'

/**
 * An IMAP SEARCH or THREAD result includes one token per matching UID. Keep
 * each request small enough that a mailbox with millions of messages cannot
 * turn one response into an over-size wire buffer.
 */
export const IMAP_UID_WINDOW_SIZE = 100

export type ImapUidWindow = { lower: number; upper: number }

export const uidWindowEndingAt = (upper: number): ImapUidWindow | null => {
  if (!Number.isSafeInteger(upper) || upper < 1) return null
  return { lower: Math.max(1, upper - IMAP_UID_WINDOW_SIZE + 1), upper }
}

/** Add a UID criterion without leaving a broad `ALL` beside it. */
export const withinUidWindow = (criteria: ImapPart[], window: ImapUidWindow): ImapPart[] => {
  const scoped = criteria.length === 1 && criteria[0] === 'ALL' ? [] : criteria
  const uid = `UID ${window.lower}:${window.upper}`
  return scoped.length === 0 ? [uid] : [uid, ' ', ...scoped]
}
