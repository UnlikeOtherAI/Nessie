import { useRef, useState } from 'react'
import { newResearchActionId } from '../../../facades/deep-water/mutations'
import { createIntentActionIds, type HeldActionId, type IntentActionIds } from './intent-action-ids'

/**
 * The React side of `createIntentActionIds` (intent-action-ids.ts): a
 * control's keys, held in memory for one mount or in the stored draft that
 * keeps the body they were sent with.
 */

/** The keys for one control's intents, kept for as long as it is mounted. */
export const useIntentActionId = (): IntentActionIds => {
  const [ids] = useState(() => createIntentActionIds(newResearchActionId))
  return ids
}

/**
 * The keys for an intent whose body lives in a stored draft: the held key is
 * read from, and written to, that draft (`held`, `save`), so it comes back
 * with the body after the dialog closes or the page reloads. `save` must
 * store the key before the request is sent — a tab closed while the request
 * is on its way still has it.
 *
 * The latest render's `held` is read through a ref, because a stored draft is
 * restored after the first render; a key taken since the last render is kept
 * there too, until the draft that carries it renders.
 */
export const useStoredIntentActionId = (
  held: HeldActionId | null,
  save: (held: HeldActionId | null) => void,
): IntentActionIds => {
  const latest = useRef({ held, save })
  latest.current = { held, save }
  const [ids] = useState(() => createIntentActionIds(newResearchActionId, {
    get: () => latest.current.held,
    set: (next) => {
      latest.current = { ...latest.current, held: next }
      latest.current.save(next)
    },
  }))
  return ids
}
