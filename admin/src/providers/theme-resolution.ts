import type { Theme } from './theme-storage'

/**
 * Which theme is in force, and why
 * (docs/plans/2026-09-05-organisation-custom-theme.md §5.1).
 *
 * Pure, and tested directly as a table in `admin/test/theme-resolution.test.ts`:
 * this is the whole meaning of "the organisation's theme is the default", and
 * a rule this small is worth being able to read in one place.
 */

/** A theme id that names a `[data-theme]` block — what gets written to the DOM. */
export type AppliedTheme = Exclude<Theme, 'system'>

export type ThemeResolutionInput = {
  localChoice: Theme | null
  organizationHasTheme: boolean
  serverChoice: Theme | undefined
  signedIn: boolean
  systemDark: boolean
}

export type ThemeResolution = {
  /** What the picker shows as selected. */
  applied: AppliedTheme
  /** What `data-theme` is set to. */
  choice: Theme
}

export const DEFAULT_THEME: AppliedTheme = 'sandstone'

export const resolveThemeChoice = (input: ThemeResolutionInput): ThemeResolution => {
  // Signed out there is no account to ask, and a server value from a previous
  // session must not outlive it.
  const explicit = input.signedIn ? input.serverChoice ?? input.localChoice : input.localChoice
  // Only an explicit choice beats the organisation's palette. A person who has
  // never opened the picker is the person the default exists for.
  const choice: Theme = explicit ?? (input.organizationHasTheme ? 'organization' : DEFAULT_THEME)

  if (choice === 'system') {
    // Unchanged: System follows the OS between the two built-ins. It does not
    // substitute the organisation palette when the OS mode happens to match its
    // appearance — that person asked for their OS's mode.
    return { applied: input.systemDark ? 'nebula' : 'daylight', choice }
  }
  if (choice === 'organization') {
    // The stored choice is kept even where it cannot render — in an
    // organisation with no palette, or after one is removed — so it comes back
    // to them if a palette returns.
    return { applied: input.organizationHasTheme ? 'organization' : DEFAULT_THEME, choice }
  }
  return { applied: choice, choice }
}
