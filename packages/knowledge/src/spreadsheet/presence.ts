import {
  SPREADSHEET_LIMITS,
  SpreadsheetPresenceFrameSchema,
  type SpreadsheetPresenceEvent,
} from '@nessie/schemas'

import { invalidRequest } from './errors.js'
import { loadHead } from './head.js'
import { toSpreadsheetActor, type SpreadsheetServiceDeps, type SpreadsheetWriteActor } from './deps.js'

/**
 * Presence is a **broadcast of ephemeral facts, not a stored roster**. The
 * server validates, stamps and forwards; nothing is persisted, and a replica
 * that never saw a frame is not missing state — the next heartbeat or a
 * `sheet.presence.request` re-announces it.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/realtime-and-presence.md
 */

/**
 * Per-replica frame budget. **A cache, not an authority**: it exists to stop
 * one pane flooding the lane, and a person who lands on another replica simply
 * gets their own bucket. Closure state of the factory, never module scope.
 */
export const createPresenceBudget = (
  options: { framesPerSecond?: number; now?: () => number } = {},
) => {
  const limit = options.framesPerSecond ?? SPREADSHEET_LIMITS.maxPresenceFramesPerSecond
  const now = options.now ?? Date.now
  const buckets = new Map<string, { windowStart: number; count: number }>()

  return {
    allow: (key: string): boolean => {
      const at = now()
      const bucket = buckets.get(key)
      if (!bucket || at - bucket.windowStart >= 1_000) {
        buckets.set(key, { windowStart: at, count: 1 })
        // Bounded so a long-lived replica cannot accumulate a bucket per pane
        // that ever existed. Dropping an entry only costs it a fresh window.
        if (buckets.size > 10_000) {
          for (const [candidate, entry] of buckets) {
            if (at - entry.windowStart >= 5_000) buckets.delete(candidate)
          }
        }
        return true
      }
      if (bucket.count >= limit) return false
      bucket.count += 1
      return true
    },
  }
}

export type PresenceBudget = ReturnType<typeof createPresenceBudget>

export type PublishPresenceInput = {
  organizationId: string
  pageId: string
  actor: SpreadsheetWriteActor
  frame: unknown
  /** Read access is enough for selection and cursor; a draft needs write. */
  canWrite: boolean
  budget?: PresenceBudget
}

export const publishSpreadsheetPresence = async (
  deps: SpreadsheetServiceDeps,
  input: PublishPresenceInput,
): Promise<{ published: boolean; event: SpreadsheetPresenceEvent | null }> => {
  const parsed = SpreadsheetPresenceFrameSchema.safeParse(input.frame)
  if (!parsed.success) {
    throw invalidRequest('That presence frame could not be read', { issues: parsed.error.issues })
  }
  const frame = parsed.data
  if (frame.draft && !input.canWrite) {
    throw invalidRequest('A draft may only be shown by somebody who can edit this spreadsheet')
  }
  if (input.budget && !input.budget.allow(`${input.actor.id}:${frame.clientId}`)) {
    // Dropped, not refused: a rate-limited frame is superseded by the next one
    // within 100 ms, and a 429 would only make the pane retry.
    return { published: false, event: null }
  }

  const head = await loadHead(deps.prisma as never, input.organizationId, input.pageId)
  const event: SpreadsheetPresenceEvent = {
    ...frame,
    pageId: input.pageId,
    actor: toSpreadsheetActor(input.actor),
    // Stamped by the server from the head so a peer on another sheet can be
    // labelled without a lookup; the index is what the overlay compares.
    sheetName: head.sheetNames[frame.sheet] ?? '',
  }
  await deps.publish?.('sheet.presence', {
    pageId: input.pageId,
    organizationId: input.organizationId,
    data: event,
  })
  return { published: true, event }
}

export const publishSpreadsheetPresenceLeave = async (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string; clientId: string },
): Promise<void> => {
  await deps.publish?.('sheet.presence.leave', {
    pageId: input.pageId,
    organizationId: input.organizationId,
    data: { pageId: input.pageId, clientId: input.clientId },
  })
}

/** Asked by a freshly connected pane so its peers re-announce themselves. */
export const requestSpreadsheetPresence = async (
  deps: SpreadsheetServiceDeps,
  input: { organizationId: string; pageId: string },
): Promise<void> => {
  await deps.publish?.('sheet.presence.request', {
    pageId: input.pageId,
    organizationId: input.organizationId,
    data: { pageId: input.pageId },
  })
}
