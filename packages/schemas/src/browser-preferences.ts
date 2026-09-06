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
 * Hostnames configuration must not point a browser at.
 *
 * Lexical hardening, not a guarantee — say so plainly. It stops a home page
 * being *persisted* as an address that reads the provider VM's own services;
 * it cannot stop a name that resolves into private space (`…nip.io`), and a
 * lexical check never can, because resolution happens later and can change.
 * The session runs on the provider's machine, so "local" here means theirs:
 * their loopback, their link-local, and the cloud metadata endpoints, which
 * are the ordinary way to turn "navigate somewhere" into "read the instance's
 * credentials". Whatever loads comes back through the live view, the tab
 * capture and the agent's page reads, from a browser that may be carrying
 * somebody's logins.
 *
 * The WHATWG parser does much of the work before this is reached: `2130706433`,
 * `0177.0.0.1`, `0x7f.0.0.1`, `127.1` all normalise to `127.0.0.1`, and
 * `0:0:0:0:0:0:0:1` to `::1`. What it does *not* normalise away is a trailing
 * dot (`localhost.` stays), and it maps a v4-in-v6 literal to hex
 * (`[::ffff:127.0.0.1]` → `::ffff:7f00:1`) rather than to a dotted quad — both
 * of which read as ordinary public names to a naive check.
 */
const isForbiddenHomepageHost = (hostname: string): boolean => {
  // Brackets around an IPv6 literal, and the root's trailing dot: `localhost.`
  // and `metadata.google.internal.` resolve exactly as the undotted names do.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')

  // An IPv6 host always contains a colon and a domain never does. Without this
  // the v6 prefix tests below match ordinary sites — `fda.gov` and
  // `fcbarcelona.com` both begin "fd"/"fc" — and refuse them.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    // Link-local, and unique-local (fc00::/7).
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true
    // A v4 address wearing a v6 literal: the parser writes the last 32 bits as
    // hex, so `[::ffff:169.254.169.254]` arrives as `::ffff:a9fe:a9fe` and
    // would otherwise sail past every rule below.
    if (host.startsWith('::ffff:')) return true
    return false
  }

  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === 'metadata.google.internal' || host === 'metadata') return true

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (a === 127 || a === 10 || a === 0) return true
  // Link-local, which is where the cloud metadata endpoints live.
  if (a === 169 && b === 254) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  // Carrier-grade NAT, 100.64/10.
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * A home page as it may be stored and navigated to.
 *
 * `http`/`https` only, never a credentialed URL, and never a loopback,
 * private or link-local address: this value is set in settings and then
 * navigated to inside an agent's browser. A `javascript:` or `data:` URL
 * there would run in the live view's page; a `user:pass@` one would put a
 * password in the tab strip and in every capture of it; and a metadata or
 * loopback address would read the provider VM's own services back through a
 * browser that may hold somebody's logins. The cascade has a personal level,
 * so this is not an administrator-only value in practice.
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
  if (url.hostname === '') return false
  return !isForbiddenHomepageHost(url.hostname)
}

export const BrowserHomepageSchema = z.string().trim().min(1).max(2000)
  .refine(isNavigableHomepage, {
    message: 'Enter a public http:// or https:// address, with no username or password in it.',
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
