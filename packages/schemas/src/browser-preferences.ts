import { z } from 'zod'

/**
 * What an agent's browser opens as: how big its window is, and where it lands.
 *
 * Both are preferences with a default, not settings that must be chosen, and
 * both are read in three places — the worker opening a session for a run, the
 * API opening one for a person, and the admin drawing the control that changes
 * them. They live here so those three cannot drift; nothing in this file
 * reaches the network or the database.
 */

/**
 * A regular laptop window, which is what a page should assume unless somebody
 * says otherwise: wide enough that sites serve their desktop layout, short
 * enough to fit a live view in a panel without scaling to nothing.
 */
export const DEFAULT_BROWSER_VIEWPORT = { height: 800, width: 1280 } as const

/**
 * The provider's working range. Narrower than 320 and the live view is
 * unusable; wider than 3840 and session creation is refused. Mirrored by
 * `agent_browsers_viewport_chk`, so a value that passes here also passes the
 * database.
 */
export const BROWSER_VIEWPORT_BOUNDS = {
  maxHeight: 2160,
  maxWidth: 3840,
  minHeight: 320,
  minWidth: 320,
} as const

export const BrowserViewportSchema = z.object({
  height: z.number().int()
    .min(BROWSER_VIEWPORT_BOUNDS.minHeight)
    .max(BROWSER_VIEWPORT_BOUNDS.maxHeight),
  width: z.number().int()
    .min(BROWSER_VIEWPORT_BOUNDS.minWidth)
    .max(BROWSER_VIEWPORT_BOUNDS.maxWidth),
})

export type BrowserViewport = z.infer<typeof BrowserViewportSchema>

/**
 * The sizes offered by name. A free pair is still accepted — the schema above
 * is the authority — but naming the common ones is what makes the control a
 * choice rather than two number fields.
 */
export const BROWSER_VIEWPORT_PRESETS: ReadonlyArray<{
  id: string
  label: string
  viewport: BrowserViewport
}> = [
  { id: 'laptop', label: 'Laptop', viewport: { height: 800, width: 1280 } },
  { id: 'desktop', label: 'Desktop', viewport: { height: 900, width: 1440 } },
  { id: 'wide', label: 'Wide', viewport: { height: 1050, width: 1680 } },
  { id: 'tablet', label: 'Tablet', viewport: { height: 1024, width: 768 } },
  { id: 'phone', label: 'Phone', viewport: { height: 844, width: 390 } },
]

/** Null width or height — a row on the default — reads as the default. */
export const browserViewportOrDefault = (
  stored: { width: number | null; height: number | null } | null | undefined,
): BrowserViewport =>
  stored && stored.width !== null && stored.height !== null
    ? { height: stored.height, width: stored.width }
    : { ...DEFAULT_BROWSER_VIEWPORT }

/** The scoped-settings key carrying the home page, at any of the three levels. */
export const BROWSER_HOMEPAGE_SETTING_KEY = 'browser.homepage'

/** Where a browser lands when nobody has said otherwise. */
export const DEFAULT_BROWSER_HOMEPAGE = 'https://www.google.com'

/**
 * A home page as it may be stored and navigated to.
 *
 * `http`/`https` only, and never a credentialed URL: this value is typed by an
 * administrator and then navigated to inside an agent's browser — a `javascript:`
 * or `data:` URL there would run in the live view's page, and a `user:pass@`
 * one would put a password in the tab strip and in every capture of it.
 */
export const isNavigableHomepage = (value: string): boolean => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  return url.hostname !== ''
}

export const BrowserHomepageSchema = z.string().trim().min(1).max(2000)
  .refine(isNavigableHomepage, {
    message: 'Enter a http:// or https:// address with no username or password in it.',
  })

/**
 * The home page in force, given whatever the cascade resolved. Anything that
 * is not a usable address — a cleared value, a row from before this setting
 * existed, a hand-edited one — falls back rather than failing a session open.
 */
export const resolveBrowserHomepage = (resolved: unknown): string =>
  typeof resolved === 'string' && isNavigableHomepage(resolved.trim())
    ? resolved.trim()
    : DEFAULT_BROWSER_HOMEPAGE
