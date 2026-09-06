import { BrowserHomepageSchema, resolveBrowserHomepage } from '@nessie/schemas'

import type { ResolvedSetting, SettingScope } from '../../../facades/settings/hooks'

/**
 * What one level of the home-page cascade shows, and whether it may be edited.
 *
 * Pure, and kept out of the field that renders it, because the same three
 * answers are needed at three levels of the one panel — the organisation's, a
 * team's and a person's — and a component that derives them inline can only be
 * checked by driving a form. `browser.homepage` also has the trait that makes
 * a derivation easy to get wrong: the resolver returns the value *in force*
 * together with the level it came from, so "what this level stores" and "what
 * this level inherits" are two readings of the same field, and a control that
 * confuses them either pre-fills a value the level never set — which then gets
 * written back as an override the moment somebody presses Save — or offers to
 * clear an override that is not there.
 */

export type BrowserHomepageFieldState = {
  /** Whether this level may still write the key; false below somebody's lock. */
  canEdit: boolean
  /**
   * The address that applies when this level sets nothing of its own. It is
   * the field's placeholder rather than its value, so an empty box and a box
   * holding the same address as the level above stay distinguishable — one
   * follows whatever the organisation changes to next, the other does not.
   *
   * While this level *does* hold an override there is nothing above it to
   * report: the resolver stops at the most specific value, so the level above
   * is not in the answer at all and this falls back to the built-in default.
   * The placeholder is hidden behind that override anyway, and the refetch
   * after a clear brings back the address that really took over.
   */
  inheritedHomepage: string
  /**
   * Whether this level currently holds the lock. Carried through every write
   * of the value, because a write replaces the whole row: sending the address
   * on its own would silently release a lock the level had set.
   */
  lockedHere: boolean
  /** Whether this level has an override of its own, and so has one to clear. */
  overriddenHere: boolean
  /** The address this level stores, or `''` when it stores none. */
  ownValue: string
}

export const browserHomepageFieldState = (
  setting: ResolvedSetting | undefined,
  scope: SettingScope,
): BrowserHomepageFieldState => {
  // A value that is not a string is a row from before this key existed or one
  // edited by hand. It reads as "this level sets nothing" rather than as an
  // override nobody can see the text of.
  const stored = setting && setting.setAtScope === scope && typeof setting.value === 'string'
    ? setting.value
    : null

  return {
    // An unanswered query gates nothing, matching `ScopedSettingGate`: the
    // control is drawn plainly until the server says a level above owns it.
    canEdit: setting?.canEdit ?? true,
    inheritedHomepage: resolveBrowserHomepage(stored === null ? setting?.value : null),
    lockedHere: setting?.lockedHere ?? false,
    overriddenHere: stored !== null,
    ownValue: stored ?? '',
  }
}

/**
 * What pressing Save does with what is in the box.
 *
 * An empty box is a request to fall back, not a bad address — that is the one
 * way to drop an override — so it never reaches the schema. Anything else is
 * validated here rather than at the server: `browser.homepage` is navigated to
 * inside an agent's browser, and a `javascript:` or credentialed URL is
 * refused by `BrowserHomepageSchema` in both places, but bouncing a person's
 * typo off the network to learn that costs a round trip and loses the message
 * beside the field.
 */
export type BrowserHomepageSaveDecision =
  | { kind: 'clear' }
  | { kind: 'refused'; message: string }
  | { kind: 'save'; value: string }

export const decideBrowserHomepageSave = (draft: string): BrowserHomepageSaveDecision => {
  if (draft.trim() === '') return { kind: 'clear' }

  const parsed = BrowserHomepageSchema.safeParse(draft)
  if (!parsed.success) {
    // The schema's own sentence, not a second one written here: two spellings
    // of the same refusal drift, and only one of them is what the server says.
    return { kind: 'refused', message: parsed.error.issues[0]?.message ?? 'That address cannot be used.' }
  }
  return { kind: 'save', value: parsed.data }
}
