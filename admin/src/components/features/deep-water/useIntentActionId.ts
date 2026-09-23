import { useMemo, useRef } from 'react'
import { newResearchActionId } from '../../../facades/deep-water/mutations'

/**
 * One idempotency key per intent (nessie.md §7.1 `actionId`).
 *
 * A request whose answer was lost may still have been recorded, so sending the
 * same thing again must reuse its key — the server then answers it as a replay
 * instead of paying for a second planner turn. A different body is a different
 * intent and gets a fresh key, and so does anything after an outcome the
 * server did decide (a success, or a refusal).
 */
export const useIntentActionId = () => {
  const held = useRef<{ id: string; signature: string } | null>(null)
  return useMemo(() => ({
    /** The key for this body: the held one when retrying the same body. */
    take: (body: unknown): string => {
      const signature = JSON.stringify(body)
      if (held.current?.signature !== signature) {
        held.current = { id: newResearchActionId(), signature }
      }
      return held.current.id
    },
    /** Keep the key only when the next attempt at this body would be a retry. */
    settle: (retrySameAction: boolean): void => {
      if (!retrySameAction) held.current = null
    },
  }), [])
}
