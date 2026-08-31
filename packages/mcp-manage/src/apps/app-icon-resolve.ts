import type { PrismaClient } from '@prisma/client'

import {
  MAX_ICON_BYTES,
  readCappedIconBody,
  safeIconFetch,
  storeIconBytes,
} from '../registry/icon-store.js'
import { sniffImageMime, type IconFetch, type IconFileService } from '../registry/registry-icons.js'

/**
 * An app's icon, fetched once on first view and shared by the whole instance.
 *
 * The store had no icons at all: caching was wired only into the owner-triggered
 * sync route, and the scheduled sweep — the only sync that has ever written rows
 * in production — passes no cacher, so all 5,548 rows rendered a monogram. The
 * fix is not to make the sweep fetch 5,500 icons on a timer. It is to fetch an
 * icon when somebody actually looks at the app, keep it, and serve that one copy
 * to everybody afterwards.
 *
 * Why lazily:
 * - **Bounded by attention.** Only apps a person actually sees cost a request,
 *   so the instance never becomes a scanner walking every URL in the registry.
 * - **Self-healing.** A row that gains a website later resolves the next time it
 *   is viewed; no backfill job, no re-sweep.
 * - **Shared.** The result is one attachment served cross-org by
 *   `GET /api/apps/:id/icon` under the same store-visibility floor as the
 *   record, so the second viewer — in any organisation — pays nothing.
 *
 * Why an icon may still be absent: the MCP Registry publishes an `icons` field
 * on roughly 8% of records, so the site's own favicon is the real source, and
 * ~75% of catalogue rows carry a `websiteUrl` to derive one from. The rest keep
 * the monogram, which is a legitimate final state rather than a failure.
 */

/**
 * A person is looking at a card while this runs, so the whole resolution is
 * budgeted rather than each hop: four candidates at the shared 10 s icon
 * timeout would leave a request open for forty seconds.
 */
const TOTAL_RESOLVE_BUDGET_MS = 6_000
const PER_CANDIDATE_TIMEOUT_MS = 2_500

/** Where a derived icon came from, recorded as the entry's `iconSource`. */
export const SITE_ICON_SOURCE = 'site_favicon'

/**
 * Conventional favicon locations, best first.
 *
 * `apple-touch-icon.png` leads because it is specified to be a raster of decent
 * size, where `/favicon.ico` is frequently a 16px ICO — a format `sniffImageMime`
 * rejects, and rightly: the store renders a 40px tile.
 */
const ICON_PATHS = ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/favicon.png', '/favicon.ico'] as const

/**
 * Candidate URLs for one site, origin-only.
 *
 * The path is replaced rather than appended to, and anything but http(s) is
 * refused, so a `websiteUrl` a registry author chose cannot steer the fetch to a
 * path of their choosing on a host of their choosing. `safeFetch` still pins the
 * address and bounds redirects; this is the layer above that.
 */
export const siteIconCandidates = (websiteUrl: string): string[] => {
  let origin: string
  try {
    const parsed = new URL(websiteUrl)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return []
    origin = parsed.origin
  } catch {
    return []
  }
  return ICON_PATHS.map((path) => `${origin}${path}`)
}

/** Fetch one candidate and return validated raster bytes, or null. */
const fetchIconBytes = async (
  url: string,
  fetchIcon: IconFetch,
): Promise<{ bytes: Buffer; mime: 'image/png' | 'image/jpeg' | 'image/webp' } | null> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PER_CANDIDATE_TIMEOUT_MS)
  timeout.unref?.()
  try {
    const response = await fetchIcon(url, { signal: controller.signal })
    if (!response.ok || !response.body) return null
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) return null
    const bytes = await readCappedIconBody(response.body, controller)
    if (!bytes) return null
    // Sniffed, never taken from `content-type`: the header is the remote host's
    // claim, and an SVG mislabelled as a PNG would be a script container we then
    // served from our own origin.
    const mime = sniffImageMime(bytes)
    return mime ? { bytes, mime } : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export type AppIconResolution = { attachmentId: string } | null

/**
 * Resolve and persist one app's icon, at most once.
 *
 * Concurrency and the stamp are both handled by one conditional UPDATE; see
 * the claim comment inside. The short version: exactly one caller fetches,
 * every other caller renders a monogram and picks the result up on the next
 * paint, and no lock or transaction is ever held across network I/O.
 */
export const resolveAppIcon = async (params: {
  actorId: string
  entryId: string
  fetchIcon?: IconFetch
  fileService: IconFileService
  organizationId: string
  prisma: PrismaClient
}): Promise<AppIconResolution> => {
  const fetchIcon = params.fetchIcon ?? safeIconFetch

  const entry = await params.prisma.mcpCatalogEntry.findUnique({
    where: { id: params.entryId },
    select: { displayName: true, iconAttachmentId: true, iconResolvedAt: true, label: true, websiteUrl: true },
  })
  if (!entry) return null
  if (entry.iconAttachmentId) return { attachmentId: entry.iconAttachmentId }
  // Already tried and found nothing: the monogram is the answer.
  if (entry.iconResolvedAt) return null

  const candidates = entry.websiteUrl ? siteIconCandidates(entry.websiteUrl) : []

  /**
   * Claim the attempt with one conditional UPDATE, before fetching anything.
   *
   * This is the whole concurrency design, and it deliberately does **not** take
   * a lock: a grid paints up to a hundred cards at once, and holding an
   * advisory lock — or a transaction — across several seconds of third-party
   * network I/O would pin a connection per icon and exhaust the pool. The
   * `count === 0` loser returns immediately and renders its monogram; the next
   * paint reads the winner's result. Stamping *before* the fetch also means a
   * site that serves no icon is attempted exactly once, ever, rather than on
   * every page view: the store never becomes a crawler paced by browsing.
   */
  const claim = await params.prisma.mcpCatalogEntry.updateMany({
    data: { iconResolvedAt: new Date() },
    where: { iconAttachmentId: null, iconResolvedAt: null, id: params.entryId },
  })
  if (claim.count === 0) {
    // Somebody else is resolving, or already did. Re-read rather than guess.
    const settled = await params.prisma.mcpCatalogEntry.findUnique({
      select: { iconAttachmentId: true },
      where: { id: params.entryId },
    })
    return settled?.iconAttachmentId ? { attachmentId: settled.iconAttachmentId } : null
  }
  if (candidates.length === 0) return null

  const displayName = entry.displayName ?? entry.label
  const deadline = Date.now() + TOTAL_RESOLVE_BUDGET_MS
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break
    const fetched = await fetchIconBytes(candidate, fetchIcon)
    if (!fetched) continue
    const stored = await storeIconBytes({
      actorId: params.actorId,
      bytes: fetched.bytes,
      displayName,
      fileService: params.fileService,
      mime: fetched.mime,
      organizationId: params.organizationId,
      source: SITE_ICON_SOURCE,
    })
    if (!stored) break
    await params.prisma.mcpCatalogEntry.update({
      data: { iconAttachmentId: stored.attachmentId, iconSource: stored.source },
      where: { id: params.entryId },
    })
    return { attachmentId: stored.attachmentId }
  }
  // The claim already recorded the attempt, so there is nothing more to write.
  return null
}

/** Exported for the presenter: is there anything left to try for this row? */
export const appIconIsResolvable = (row: {
  iconAttachmentId: string | null
  iconResolvedAt: Date | null
  websiteUrl: string | null
}): boolean =>
  row.iconAttachmentId !== null || (row.iconResolvedAt === null && row.websiteUrl !== null)
