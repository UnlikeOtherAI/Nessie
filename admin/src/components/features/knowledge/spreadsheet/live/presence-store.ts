import {
  SPREADSHEET_LIMITS,
  type SpreadsheetPresenceEvent,
  type SpreadsheetPresenceFrame,
} from '@nessie/schemas'

/**
 * Who else is in this document, kept as **ephemeral facts with an expiry**
 * rather than as a roster (`realtime-and-presence.md` §"Presence protocol").
 *
 * Nothing here is authoritative and nothing is fetched: a peer exists because
 * a frame said so within the last `PEER_EXPIRY_MS`, and stops existing when it
 * leaves, when it goes quiet, or when this pane reloads. That is the whole
 * reason the server stores nothing — a replica that never saw a frame is not
 * missing state, it is one heartbeat behind.
 *
 * Pure on purpose: expiry and throttling are the two things most likely to be
 * subtly wrong and least likely to be caught in a browser, so they are
 * answerable in `admin/test/spreadsheet-live.test.ts`.
 */

/** A peer not heard from for this long is gone. Three missed heartbeats. */
export const PEER_EXPIRY_MS = 30_000
/** The heartbeat itself, while the tab is visible. */
export const PRESENCE_HEARTBEAT_MS = 10_000
/** One frame per this much, latest wins. The server's own budget is 10/s. */
export const PRESENCE_THROTTLE_MS = 100
/** A re-announce after `sheet.presence.request` is spread over this window so
 *  N panes on one page do not answer a join in lockstep. */
export const PRESENCE_REANNOUNCE_MS = 500

export type PresencePeer = {
  event: SpreadsheetPresenceEvent
  /** Local clock, not the frame's `ts`: a peer whose clock is wrong would
   *  otherwise be expired on arrival or never expire at all. */
  seenAt: number
}

export type PresenceStore = ReturnType<typeof createPresenceStore>

export const createPresenceStore = (options: { selfClientId: string; now?: () => number }) => {
  const now = options.now ?? Date.now
  const peers = new Map<string, PresencePeer>()

  const expire = (): boolean => {
    const cutoff = now() - PEER_EXPIRY_MS
    let changed = false
    for (const [clientId, peer] of peers) {
      if (peer.seenAt <= cutoff) {
        peers.delete(clientId)
        changed = true
      }
    }
    return changed
  }

  return {
    /** A `sheet.presence` frame. Returns whether anything a reader sees moved. */
    receive: (event: SpreadsheetPresenceEvent): boolean => {
      // This pane's own frames come back off the lane like everybody else's.
      // Drawing them would put a second cursor on the person's own cell.
      if (event.clientId === options.selfClientId) return expire()
      peers.set(event.clientId, { event, seenAt: now() })
      expire()
      return true
    },
    /** A `sheet.presence.leave`: gone now, not in 30 s. */
    leave: (clientId: string): boolean => {
      const removed = peers.delete(clientId)
      return expire() || removed
    },
    /** Called on a timer so a peer that stopped sending actually disappears. */
    expire,
    /** Newest first, so the strip's five tiles are the five most recent. */
    list: (): PresencePeer[] =>
      [...peers.values()].sort((left, right) => right.seenAt - left.seenAt),
    clear: (): void => { peers.clear() },
  }
}

/**
 * The sender's throttle: at most one frame per `PRESENCE_THROTTLE_MS`, and the
 * **latest** frame wins rather than the first.
 *
 * Selection frames arrive per intercepted model call, which for a drag is one
 * per pointer move. Sending the first of each window and dropping the rest
 * would leave a peer's rectangle wherever the finger happened to be 100 ms
 * ago; sending the last is what makes the overlay track a drag.
 */
export type FrameThrottle = ReturnType<typeof createFrameThrottle>

export const createFrameThrottle = (options: {
  send: (frame: SpreadsheetPresenceFrame) => void
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
  intervalMs?: number
}) => {
  const now = options.now ?? Date.now
  const schedule = options.schedule
    ?? ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms)
      return () => clearTimeout(handle)
    })
  const interval = options.intervalMs ?? PRESENCE_THROTTLE_MS
  let pending: SpreadsheetPresenceFrame | null = null
  let cancel: (() => void) | null = null
  // Negative infinity, not 0: "never sent" has to be distinguishable from
  // "sent at time 0", and an injected clock that starts at 0 is exactly the
  // case a real one hides — the first frame would sit out a window for no
  // reason, which is the frame a peer most needs.
  let lastSentAt = Number.NEGATIVE_INFINITY

  const flush = (): void => {
    cancel = null
    if (!pending) return
    const frame = pending
    pending = null
    lastSentAt = now()
    options.send(frame)
  }

  return {
    push: (frame: SpreadsheetPresenceFrame): void => {
      pending = frame
      const since = now() - lastSentAt
      if (since >= interval) { flush(); return }
      if (!cancel) cancel = schedule(flush, interval - since)
    },
    /** A heartbeat or a `leave` must not wait behind the throttle. */
    sendNow: (frame: SpreadsheetPresenceFrame): void => {
      pending = frame
      cancel?.()
      flush()
    },
    dispose: (): void => { cancel?.(); cancel = null; pending = null },
  }
}

/** Clip a draft to what the contract carries, so an over-long one is truncated
 *  rather than refused by the server and silently never shown. */
export const clipDraft = (text: string): string =>
  text.length <= SPREADSHEET_LIMITS.maxDraftChars
    ? text
    : text.slice(0, SPREADSHEET_LIMITS.maxDraftChars)
