/**
 * "Put the caret in the composer when I get there."
 *
 * A conversation started from the rail is created empty: the only reason the
 * reader is now standing in it is to say the first thing. The intent rides in
 * the navigation entry's `state` rather than the URL — it is a one-shot fact
 * about *this* arrival, not something anybody should be able to link somebody
 * else into — and it is read through this one pair so the writer and the
 * reader cannot spell it differently.
 */

const FOCUS_COMPOSER_KEY = 'focusComposer'

/** What the caller passes as a navigation entry's `state`. */
export const focusComposerState = (): { focusComposer: true } => ({
  [FOCUS_COMPOSER_KEY]: true,
})

export const readFocusComposerIntent = (state: unknown): boolean =>
  typeof state === 'object'
  && state !== null
  && !Array.isArray(state)
  && (state as Record<string, unknown>)[FOCUS_COMPOSER_KEY] === true
