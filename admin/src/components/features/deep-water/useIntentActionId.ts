import { useState } from 'react'
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
export type IntentActionIds = {
  /** The key for this body: the held one when retrying the same body. */
  take: (body: unknown) => string
  /** Keep the key only when the next attempt at this body would be a retry. */
  settle: (retrySameAction: boolean) => void
}

/** Pure, so the rule is tested without React; `mint` makes a fresh key. */
export const createIntentActionIds = (mint: () => string): IntentActionIds => {
  let held: { id: string; signature: string } | null = null
  return {
    settle: (retrySameAction) => {
      if (!retrySameAction) held = null
    },
    take: (body) => {
      const signature = JSON.stringify(body)
      if (held?.signature !== signature) held = { id: mint(), signature }
      return held.id
    },
  }
}

/** The keys for one control's intents, kept for as long as it is mounted. */
export const useIntentActionId = (): IntentActionIds => {
  const [ids] = useState(() => createIntentActionIds(newResearchActionId))
  return ids
}
