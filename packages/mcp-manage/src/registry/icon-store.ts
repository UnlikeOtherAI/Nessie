import { Readable } from 'node:stream'

import { safeFetch } from '@nessie/runtime'

import type { AllowedIconMime, IconFetch, IconFileService, RegistryIconResult } from './registry-icons.js'

/**
 * The one place icon bytes are fetched, bounded, and stored.
 *
 * Three call sites now want the same pipeline — registry-advertised icons
 * (`registry-icons.ts`), repository descriptor icons (`repository-icons.ts`),
 * and a site's own favicon resolved on first view (`apps/app-icon-resolve.ts`)
 * — and each had, or would have had, its own copy of "drain with a cap, sniff
 * the MIME, hand it to the FileService". A third copy is the fork Rule zero
 * names, so the shared middle moved here rather than being written again.
 *
 * What the pipeline guarantees, wherever it is called from:
 * - the fetch is IP-pinned and redirect-bounded (`safeFetch`), because every
 *   URL involved is chosen by somebody outside this system;
 * - the body is drained against a hard byte cap, so a dishonest or absent
 *   `content-length` cannot exhaust memory;
 * - bytes are MIME-**sniffed**, never trusted from a header, and only raster
 *   PNG/JPEG/WebP survives — an SVG is a script container and is dropped;
 * - storage goes through the one `FileService`, so the bytes are accounted.
 */

/** A single icon is small; anything larger is not an icon. */
export const MAX_ICON_BYTES = 512 * 1024

export const ICON_FETCH_TIMEOUT_MS = 10_000

/** Enough to follow a vanity host to its CDN, not enough to be a crawler. */
export const MAX_ICON_REDIRECTS = 2

/** Production icon fetch: SSRF-safe, redirect-bounded, and signal-abortable. */
export const safeIconFetch: IconFetch = (url, init) =>
  safeFetch(
    url,
    { method: 'GET', redirect: 'follow', signal: init.signal },
    { maxRedirects: MAX_ICON_REDIRECTS },
  )

const extensionFor = (mime: AllowedIconMime): 'jpg' | 'png' | 'webp' =>
  mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp'

/**
 * A filename a person would recognise in a storage listing. The display name is
 * slugged rather than interpolated: it comes from a registry record, so it is
 * somebody else's text.
 */
export const iconFilename = (displayName: string, extension: string): string => {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  return `${slug.length > 0 ? slug : 'app'}-icon.${extension}`
}

/**
 * Drain a response body into a Buffer, refusing to exceed `MAX_ICON_BYTES`.
 *
 * The check runs on every chunk, so an over-cap transfer is aborted mid-stream
 * rather than after the fact: `controller.abort()` releases the socket and the
 * stream's own `cancel()` runs. Returns null when the cap is crossed — no icon
 * is an ordinary outcome, and a caller that treated it as an error would fail a
 * page over a missing picture.
 */
export const readCappedIconBody = async (
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
  return chunks.length > 0 ? Buffer.concat(chunks, total) : null
}

/**
 * Store already-validated icon bytes through the one `FileService`.
 *
 * `source` is the provenance the catalogue records, so a later reader can tell
 * a publisher-declared icon from one Nessie derived from the site.
 */
export const storeIconBytes = async (params: {
  actorId: string
  bytes: Buffer
  displayName: string
  fileService: IconFileService
  mime: AllowedIconMime
  organizationId: string
  source: string
}): Promise<RegistryIconResult | null> => {
  try {
    const { attachment } = await params.fileService.store({
      attribution: { organizationId: params.organizationId, actorId: params.actorId },
      body: Readable.from(params.bytes),
      filename: iconFilename(params.displayName, extensionFor(params.mime)),
      mime: params.mime,
      organizationId: params.organizationId,
      uploaderId: params.actorId,
    })
    return { attachmentId: attachment.id, source: params.source }
  } catch {
    // A quota refusal or a storage outage must not fail the page that asked
    // for a picture. The caller records "resolved, nothing found" and the card
    // keeps its monogram.
    return null
  }
}
