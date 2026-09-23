/**
 * One idempotency key per intent (nessie.md §7.1 `actionId`).
 *
 * A request whose answer was lost may still have been recorded, so sending the
 * same thing again must reuse its key — the server then answers it as a replay
 * instead of paying for a second planner turn. A different body is a different
 * intent and gets a fresh key, and so does anything after an outcome the
 * server did decide (a success, or a refusal).
 *
 * The key must outlive the control that minted it wherever the body does: a
 * brief's question, reply and edits are kept in a stored draft, so closing the
 * dialog or reloading brings them back, and the key they were last sent with
 * comes back beside them (`useStoredIntentActionId`). Otherwise pressing the
 * button again after a lost answer would send the same body under a new key
 * and open — and pay for — a second brief or planner turn.
 */
export type IntentActionIds = {
  /** The key for this body: the held one when retrying the same body. */
  take: (body: unknown) => string
  /** Keep the key only when the next attempt at this body would be a retry. */
  settle: (retrySameAction: boolean) => void
}

/** The key last sent, and the body it was sent with, until the server has decided that body. */
export type HeldActionId = { actionId: string; signature: string }

/** Where the held key lives: in memory for one mount, or in a stored draft. */
export type HeldActionIdStore = {
  get: () => HeldActionId | null
  set: (held: HeldActionId | null) => void
}

const memoryStore = (): HeldActionIdStore => {
  let held: HeldActionId | null = null
  return {
    get: () => held,
    set: (next) => {
      held = next
    },
  }
}

/** Pure, so the rule is tested without React; `mint` makes a fresh key. */
export const createIntentActionIds = (
  mint: () => string,
  store: HeldActionIdStore = memoryStore(),
): IntentActionIds => ({
  settle: (retrySameAction) => {
    if (!retrySameAction && store.get() !== null) store.set(null)
  },
  take: (body) => {
    const signature = JSON.stringify(body)
    const held = store.get()
    if (held?.signature === signature) return held.actionId
    const next = { actionId: mint(), signature }
    store.set(next)
    return next.actionId
  },
})

/** Storage is untrusted input: a held key is kept only in its known shape. */
export const reviveHeldActionId = (stored: unknown): HeldActionId | null => {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null
  const { actionId, signature } = stored as Record<string, unknown>
  return typeof actionId === 'string' && actionId !== '' && typeof signature === 'string'
    ? { actionId, signature }
    : null
}
