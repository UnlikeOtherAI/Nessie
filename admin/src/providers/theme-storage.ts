/**
 * The three keys behind a themed first paint
 * (docs/plans/2026-09-05-organisation-custom-theme.md §4.2).
 *
 * One key each, with one meaning, replacing the single `nessie.theme` that
 * conflated "what this person chose" with "what was last painted". That
 * conflation is why every account ended up carrying an explicit `sandstone`:
 * the apply effect wrote the default back as though it were a choice, and the
 * first sign-in copied it onto the account.
 */

export type Theme =
  | 'organization'
  | 'nebula'
  | 'midnight'
  | 'daylight'
  | 'forest'
  | 'ocean'
  | 'sunset'
  | 'rose'
  | 'graphite'
  | 'sandstone'
  | 'contrast'
  | 'system'

export const THEME_IDS: readonly Theme[] = [
  'organization', 'nebula', 'midnight', 'daylight', 'forest', 'ocean',
  'sunset', 'rose', 'graphite', 'sandstone', 'contrast', 'system',
]

/** The person's explicit pick. Written only by the picker, never by a default. */
const CHOICE_KEY = 'nessie.theme.choice'
/** The id last written to `data-theme`, so a reload paints it before React runs. */
const APPLIED_KEY = 'nessie.theme.applied'
/** The organisation palette's CSS, verbatim — a first-paint hint, never authority. */
const CSS_KEY = 'nessie.theme.css'
/** Superseded by the three above; removed rather than read (see the module note). */
const LEGACY_KEY = 'nessie.theme'

export const ORGANIZATION_THEME_STYLE_ID = 'nessie-organization-theme'

const themeIds = new Set<string>(THEME_IDS)

export const isTheme = (value: string | null): value is Theme =>
  value !== null && themeIds.has(value)

const read = (key: string): string | null => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    // Storage can be unavailable in private or constrained browser contexts.
    return null
  }
}

const write = (key: string, value: string | null): void => {
  if (typeof window === 'undefined') return
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // As above: a themed first paint is a nicety, never a requirement.
  }
}

export const readThemeChoice = (): Theme | null => {
  const stored = read(CHOICE_KEY)
  return isTheme(stored) ? stored : null
}

export const writeThemeChoice = (theme: Theme): void => write(CHOICE_KEY, theme)

export const writeAppliedTheme = (theme: string): void => write(APPLIED_KEY, theme)

export const writeOrganizationThemeCss = (css: string | null): void => write(CSS_KEY, css)

/** The old single key cannot be trusted as a choice, so it is dropped, not read. */
export const forgetLegacyTheme = (): void => write(LEGACY_KEY, null)
