import { safeIconFetch } from './icon-store.js'
import type { IconFetch } from './registry-icons.js'

/**
 * Where an app's icon can be found, in descending order of what it is worth.
 *
 * Guessing four conventional paths resolved about a third of the catalogue.
 * Measured against fourteen rows that failed, the sites were not iconless —
 * eleven of them declared `<link rel="icon">`, just not at a path anybody can
 * guess, and a further pool is reachable through the publisher's GitHub avatar.
 * So the resolver asks each source in turn rather than guessing harder:
 *
 * 1. **What the publisher declared** to the MCP Registry (`server.icons`) —
 *    the only source where somebody stated *this is my icon*.
 * 2. **What the site's own HTML declares** — `<link rel="icon">` and friends.
 * 3. **Conventional paths** — `/apple-touch-icon.png` and the rest, for sites
 *    that ship the files without declaring them.
 * 4. **The publisher's GitHub avatar** — a real, recognisable mark for the 42%
 *    of rows carrying a GitHub repository, and the last stop before a monogram.
 *
 * Every URL produced here is still fetched through `safeFetch`, capped, and
 * MIME-sniffed before storage. Nothing in this module is trusted; it only
 * decides *what to try*, and an entry that lies simply fails downstream.
 */

/** Conventional locations, best first. Apple's is specified as a real raster. */
export const CONVENTIONAL_ICON_PATHS = [
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/favicon.png',
  '/favicon.ico',
] as const

/** Only ever http(s), and only ever an absolute URL we built ourselves. */
const httpOrigin = (raw: string): string | null => {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

export const conventionalCandidates = (websiteUrl: string): string[] => {
  const origin = httpOrigin(websiteUrl)
  return origin ? CONVENTIONAL_ICON_PATHS.map((path) => `${origin}${path}`) : []
}

/**
 * The publisher's GitHub avatar, from a repository URL.
 *
 * `github.com/<owner>.png` redirects to the avatar CDN and needs no token; it
 * answered with a real PNG or JPEG for seven of eight repositories sampled. It
 * is the *publisher's* mark rather than the product's, which is why it sits
 * last — but a recognisable org avatar beats two grey letters.
 */
export const githubAvatarCandidate = (repositoryUrl: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(repositoryUrl)
  } catch {
    return null
  }
  if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return null
  const owner = parsed.pathname.split('/').filter(Boolean)[0]
  // Owner names are `[A-Za-z0-9-]`; refusing anything else keeps a crafted
  // path from turning into a different GitHub URL.
  if (!owner || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(owner)) return null
  return `https://github.com/${owner}.png?size=128`
}

/** How much of a homepage is read before giving up on finding a `<link>`. */
const MAX_HTML_BYTES = 192 * 1024
const HTML_FETCH_TIMEOUT_MS = 3_000

/**
 * Icon hrefs declared by a page's own `<link>` tags, best first.
 *
 * This is a bounded scan of `<link …>` tags rather than a real HTML parse, and
 * that is a deliberate trade: a spec parser would mean a new runtime dependency
 * in the API image for a cosmetic feature, while a mis-parse here costs exactly
 * one icon — the bytes it points at are still capped, sniffed and stored the
 * same way. Nothing about safety rests on this being correct.
 *
 * Ordering prefers `apple-touch-icon` (specified to be a real raster of usable
 * size) over a bare `icon`, and both over `mask-icon`, which is a monochrome
 * silhouette and makes a poor tile.
 */
export const parseDeclaredIconHrefs = (html: string, baseUrl: string): string[] => {
  const ranked: { href: string; rank: number }[] = []
  for (const tag of html.match(/<link\b[^>]*>/giu) ?? []) {
    const rel = tag.match(/\brel\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/iu)
    const relValue = (rel?.[2] ?? rel?.[3] ?? rel?.[4] ?? '').toLowerCase()
    if (!relValue.includes('icon')) continue
    const href = tag.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/iu)
    const hrefValue = (href?.[2] ?? href?.[3] ?? href?.[4] ?? '').trim()
    if (!hrefValue) continue
    let absolute: URL
    try {
      // Resolved against the page, so a relative href works; the scheme check
      // then refuses `data:` and anything else that is not a real fetch.
      absolute = new URL(hrefValue, baseUrl)
    } catch {
      continue
    }
    if (absolute.protocol !== 'https:' && absolute.protocol !== 'http:') continue
    const rank = relValue.includes('apple-touch-icon') ? 0 : relValue.includes('mask-icon') ? 2 : 1
    ranked.push({ href: absolute.toString(), rank })
  }
  ranked.sort((left, right) => left.rank - right.rank)
  // A page may declare the same href at several sizes; one attempt each.
  return [...new Set(ranked.map((entry) => entry.href))]
}

/** Fetch a homepage and return the icon hrefs it declares. Never throws. */
export const discoverDeclaredIcons = async (
  websiteUrl: string,
  fetchIcon: IconFetch = safeIconFetch,
): Promise<string[]> => {
  const origin = httpOrigin(websiteUrl)
  if (!origin) return []
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HTML_FETCH_TIMEOUT_MS)
  timeout.unref?.()
  try {
    const response = await fetchIcon(origin, { signal: controller.signal })
    if (!response.ok || !response.body) return []
    const type = response.headers.get('content-type') ?? ''
    // A non-HTML answer means there is nothing to scan; the SPA that returns
    // its index for every path is the reason this is checked at all.
    if (type && !type.toLowerCase().includes('html')) return []
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      total += value.byteLength
      // The `<head>` is at the top; reading the whole of a large page buys
      // nothing and costs bandwidth on somebody else's server.
      if (total >= MAX_HTML_BYTES) {
        controller.abort()
        await reader.cancel().catch(() => undefined)
        break
      }
    }
    return parseDeclaredIconHrefs(Buffer.concat(chunks, total).toString('utf8'), origin)
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}
