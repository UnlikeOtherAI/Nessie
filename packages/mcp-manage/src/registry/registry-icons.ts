import { Readable } from 'node:stream'

import { safeFetch, type StoreFileInput } from '@nessie/runtime'
import { sanitizeHttpUrl } from '@nessie/schemas'
import { z } from 'zod'

/**
 * Cache one advertised registry icon as a Nessie-served attachment.
 *
 * A registry record's `server.icons` entry is UNTRUSTED external content whose
 * URL the record's own author chose. So nothing here trusts what the record
 * says an icon is: the bytes are fetched through the IP-pinned, redirect-bounded
 * `safeFetch` (never bare `fetch`, because that URL is attacker-influenced),
 * capped *while streaming*, and the real image type is decided by sniffing the
 * magic bytes — the declared `mimeType` and the URL extension are ignored. An
 * SVG is refused outright rather than sanitised: rendering an arbitrary upstream
 * SVG in the admin origin is stored XSS, and a monogram fallback is a perfectly
 * good icon, so the safe move is simply not to cache one.
 *
 * The result is a real `Attachment` stored through the one `FileService`
 * chokepoint, so it is quota-accounted and freed by the ordinary
 * `FileService.delete` — there is no second delete path. Everything a failure
 * could touch is best-effort: any error, refusal, or oversize stream yields
 * `null`, and the caller leaves `iconAttachmentId` unset. An empty icon is never
 * a reason to fail an import.
 *
 * `RegistryRecord` retains the normalized metadata as well as the importer
 * passing the raw carrier here. That is deliberate: an owner-triggered sync
 * can cache immediately, while the ordinary scheduled sync keeps enough
 * information for the first-view resolver to make the same choice later.
 */

/** The only image types cached. SVG is deliberately absent — see the header. */
export type AllowedIconMime = 'image/png' | 'image/jpeg' | 'image/webp'

/**
 * Hard cap on downloaded icon bytes, enforced *as the body streams* so a
 * dishonest `content-length` (or none at all) cannot get past it. 512 KiB is
 * generous for a 128–256px raster logo and small enough that a hostile stream
 * is abandoned early.
 */
const MAX_ICON_BYTES = 512 * 1024

/** A logo download that has not answered in ten seconds is not worth waiting on. */
const ICON_FETCH_TIMEOUT_MS = 10_000

/** A logo host that bounces more than twice is treated as unreachable. */
const MAX_ICON_REDIRECTS = 2

/** Provenance tag persisted in `McpCatalogEntry.iconSource`; never rendered. */
export const REGISTRY_ICON_SOURCE = 'mcp_registry'

/** Preferred raster size band; a card renders the icon around 48–64px. */
const ICON_SIZE_MIN = 96
const ICON_SIZE_MAX = 320

/** One advertised icon, flattened to what selection and fetching need. */
export type RegistryIcon = {
  src: string
  mimeType: string | null
  /** Space-joined `WxH` tokens, e.g. `"128x128 256x256"`, or null. */
  sizes: string | null
  /** `null` means the publisher says this icon works on either background. */
  theme: 'light' | 'dark' | null
}

export type RegistryIconResult = {
  attachmentId: string
  source: string
}

/**
 * The fetch seam. Production is `safeFetch`; a test injects its own so the
 * validation and cap logic can be exercised with no network. The signal is
 * owned by `cacheRegistryIcon` so it can abort both on timeout and the moment
 * the stream crosses the byte cap.
 */
export type IconFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<Response>

/**
 * The `FileService` seam, narrowed to the one method icon caching uses. The
 * real `@nessie/runtime` `FileService` satisfies this structurally, so the
 * integrator hands the real service straight in; a test hands a stub. Keeping it
 * to `store` means this module can never reach past the chokepoint to
 * `storage.*` or `prisma.attachment`.
 */
export type IconFileService = {
  store(input: StoreFileInput): Promise<{ attachment: { id: string } }>
}

const AdvertisedIconSchema = z.object({
  src: z.string().min(1),
  // Stored snapshots use explicit nulls after normalization; raw Registry
  // records omit these fields. Accept both representations here.
  mimeType: z.string().nullable().optional(),
  // Manifest icons carry a space-separated string; some publishers use an
  // array. Accept both, normalise to the string form the selector expects.
  sizes: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  // A theme-specific icon must not silently stand in for one that works on
  // either background. The MCP schema defines exactly these two values.
  theme: z.enum(['light', 'dark']).nullable().optional(),
})

const IconCarrierSchema = z.object({
  // Parse entries independently below. One malformed icon must cost exactly
  // that candidate, never every valid sibling or the containing server.
  server: z.object({ icons: z.array(z.unknown()).optional() }).optional(),
})

/**
 * The advertised icons on one raw registry entry, or `[]`. Lenient by design:
 * an entry that does not parse is not an error here, it is simply an entry with
 * no icon to cache.
 */
export const parseAdvertisedIcons = (raw: unknown): RegistryIcon[] => {
  const parsed = IconCarrierSchema.safeParse(raw)
  if (!parsed.success) return []
  return (parsed.data.server?.icons ?? []).flatMap((value) => {
    const icon = AdvertisedIconSchema.safeParse(value)
    if (!icon.success) return []
    return [{
      src: icon.data.src,
      mimeType: icon.data.mimeType ?? null,
      sizes: Array.isArray(icon.data.sizes)
        ? icon.data.sizes.join(' ')
        : icon.data.sizes ?? null,
      theme: icon.data.theme ?? null,
    }]
  })
}

/**
 * Identify the real image type from the leading bytes. This is the authoritative
 * MIME decision — not the record's `mimeType`, which its author controls — so a
 * file claiming `image/png` whose bytes are an SVG, a GIF, or an HTML page is
 * rejected here (returns null). PNG/JPEG/WebP only; everything else is `null`.
 */
export const sniffImageMime = (bytes: Buffer): AllowedIconMime | null => {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

/** True when the record advertises this icon as a vector (SVG) — never cached. */
const isVectorIcon = (icon: RegistryIcon): boolean => {
  if ((icon.mimeType ?? '').toLowerCase().includes('svg')) return true
  try {
    return new URL(icon.src).pathname.toLowerCase().endsWith('.svg')
  } catch {
    return false
  }
}

/** Largest declared pixel dimension across an icon's `sizes`, or null. */
const largestDeclaredDimension = (sizes: string | null): number | null => {
  if (!sizes) return null
  let largest: number | null = null
  for (const token of sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)) {
    const dimension = Math.max(Number(token[1]), Number(token[2]))
    if (Number.isFinite(dimension) && (largest === null || dimension > largest)) {
      largest = dimension
    }
  }
  return largest
}

/**
 * Rank a fetchable candidate: a size inside the preferred band wins, an unknown
 * size is acceptable (a logo with no declared dimensions is still worth a look),
 * and a known-out-of-band size (a 16px favicon or a 1024px hero) loses. Ties
 * keep the record's own order, so the choice is deterministic.
 */
const scoreCandidate = (icon: RegistryIcon): number => {
  const largest = largestDeclaredDimension(icon.sizes)
  const sizeScore = largest === null ? 1 : largest >= ICON_SIZE_MIN && largest <= ICON_SIZE_MAX ? 2 : 0
  // A theme-free icon is the only safe default for a permanently cached
  // raster: the same attachment serves light and dark store views. Size stays
  // primary because a 16px neutral favicon is worse artwork than a card-sized
  // publisher variant. Equal theme-specific variants retain publisher order.
  const themeScore = icon.theme === null ? 1 : 0
  return sizeScore * 3 + themeScore
}

/**
 * Choose the icon URL to fetch, or null when none is worth fetching. Vector
 * icons are dropped ("advertised only an SVG → no icon"), and every `src` is run
 * through `sanitizeHttpUrl` so a `data:`/`javascript:`/relative value is refused
 * before it ever reaches the fetch — the returned string is the sanitised http(s)
 * URL, which `safeFetch` then re-validates and IP-pins.
 */
export const pickIconCandidate = (icons: readonly RegistryIcon[]): string | null => {
  let best: { url: string; score: number } | null = null
  for (const icon of icons) {
    if (isVectorIcon(icon)) continue
    const url = sanitizeHttpUrl(icon.src)
    if (!url) continue
    const score = scoreCandidate(icon)
    if (!best || score > best.score) best = { url, score }
  }
  return best?.url ?? null
}

/**
 * Drain a response body into a Buffer, refusing to exceed `MAX_ICON_BYTES`. The
 * check runs on every chunk, so an over-cap transfer is aborted mid-stream
 * rather than after the fact; `controller.abort()` releases the socket and the
 * stream's own `cancel()` runs. Returns null when the cap is crossed.
 */
const readCapped = async (
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
): Promise<Buffer | null> => {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_ICON_BYTES) {
      controller.abort()
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}

/** Cosmetic filename for the stored attachment; the id is what addresses it. */
const iconFilename = (displayName: string, mime: AllowedIconMime): string => {
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${base || 'app'}-icon.${ext}`
}

/**
 * Fetch, validate, and cache one advertised icon. Returns the attachment
 * reference on success, `null` on anything else — a missing/invalid/oversize
 * icon or a store failure is never fatal.
 *
 * `organizationId` owns the resulting attachment because the `Attachment` table
 * requires an owner (its `organizationId` is a non-null FK); registry apps are
 * instance-global, so the integrator supplies the org the icon bytes are
 * accounted to. See `createRegistryIconCacher` and the module that wires it.
 */
export const cacheRegistryIcon = async (params: {
  icons: readonly RegistryIcon[]
  fetchIcon: IconFetch
  fileService: IconFileService
  organizationId: string
  actorId: string
  displayName: string
}): Promise<RegistryIconResult | null> => {
  const url = pickIconCandidate(params.icons)
  if (!url) return null

  const controller = new AbortController()
  // Unref'd so a still-pending fetch timer never keeps the process alive; it is
  // cleared in `finally` on the normal path.
  const timeout = setTimeout(() => controller.abort(), ICON_FETCH_TIMEOUT_MS)
  timeout.unref?.()
  try {
    const response = await params.fetchIcon(url, { signal: controller.signal })
    if (!response.ok || !response.body) return null
    // Cheap early-out for an honest oversize header; the streaming cap below is
    // the real guard for a dishonest or absent one.
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ICON_BYTES) return null

    const bytes = await readCapped(response.body, controller)
    if (!bytes) return null

    // The bytes decide the type, never the record. An SVG, GIF, HTML error page,
    // or anything mislabelled fails here.
    const mime = sniffImageMime(bytes)
    if (!mime) return null

    const { attachment } = await params.fileService.store({
      attribution: { organizationId: params.organizationId, actorId: params.actorId },
      body: Readable.from(bytes),
      filename: iconFilename(params.displayName, mime),
      mime,
      organizationId: params.organizationId,
      uploaderId: params.actorId,
    })
    return { attachmentId: attachment.id, source: REGISTRY_ICON_SOURCE }
  } catch {
    // Network error, abort, refusal, or a store failure: leave the row iconless.
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * The importer's view of icon caching: given a record's advertised icons and its
 * display name, cache one and hand back the reference. It carries no org,
 * FileService, or fetch of its own — those are bound once by
 * `createRegistryIconCacher` — so the importer stays decoupled from storage.
 */
export type RegistryIconCacher = (input: {
  icons: readonly RegistryIcon[]
  displayName: string
}) => Promise<RegistryIconResult | null>

export type IconCacheContext = {
  fileService: IconFileService
  /** The org the cached attachment bytes are owned by and accounted to. */
  organizationId: string
  /** Ledger actor for the store event; the sync-triggering owner in practice. */
  actorId: string
  /** Defaults to the IP-pinned `safeFetch`; overridable for tests. */
  fetchIcon?: IconFetch
}

/** Production icon fetch: SSRF-safe, redirect-bounded, and signal-abortable. */
const safeIconFetch: IconFetch = (url, init) =>
  safeFetch(
    url,
    { method: 'GET', redirect: 'follow', signal: init.signal },
    { maxRedirects: MAX_ICON_REDIRECTS },
  )

/**
 * Bind a FileService, an owning org, and a fetch into a `RegistryIconCacher` the
 * importer can call per record. Passing no cacher to the importer disables icon
 * caching entirely, which is what a context with no storage (a plain CLI, a
 * test) does.
 */
export const createRegistryIconCacher = (ctx: IconCacheContext): RegistryIconCacher => {
  const fetchIcon = ctx.fetchIcon ?? safeIconFetch
  return ({ icons, displayName }) =>
    cacheRegistryIcon({
      icons,
      fetchIcon,
      fileService: ctx.fileService,
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      displayName,
    })
}
