import type { Readable } from 'node:stream'

import type { Attachment } from '@prisma/client'

import type { Storage } from '../storage/index.js'

/**
 * How attachment bytes reach the person who asked for them.
 *
 * Every download used to be proxied: the API opened a stream from object
 * storage and piped it to the client, so a 5 GiB transfer was pinned to one API
 * process for its whole life (audit 6.4, plan row 5.7). Under autoscaling that
 * is a download that dies when the instance is scaled in, and a request that can
 * outlive what the platform allows — Cloud Run gives a service ten fixed
 * seconds between SIGTERM and SIGKILL.
 *
 * So above a threshold the API stops carrying the bytes and hands the client a
 * signed URL instead. What the API keeps is the part only it can do:
 * **authorisation happens first and unchanged**, and the URL is minted from the
 * row that check returned.
 */

// image/svg+xml is an active-content type (it can carry <script>), so it must
// never be served inline — only raster images and PDFs preview in-browser.
const INLINE_DISPOSITION_MIMES = new Set(['application/pdf'])

/**
 * Inline preview or save-to-disk, decided from the stored MIME type alone.
 *
 * One function, because the answer has to be identical on both routes: the
 * proxy writes it into a `Content-Disposition` header, and the signed URL bakes
 * the same string into the signature. A file that previews in the browser under
 * 8 MiB and downloads over it would be the route's contract changing with the
 * file's size.
 */
export const attachmentDisposition = (mime: string): 'attachment' | 'inline' =>
  (mime.startsWith('image/') && mime !== 'image/svg+xml')
  || INLINE_DISPOSITION_MIMES.has(mime)
    ? 'inline'
    : 'attachment'

/**
 * The size at which proxying stops being the right answer.
 *
 * The budget is the API's drain, not the request timeout: a transfer only
 * survives a scale-in if it finishes inside the grace between SIGTERM and the
 * kill. `NESSIE_SHUTDOWN_TIMEOUT_MS` defaults to 25 s, the Cloud Run terraform
 * pins it to 9 s because the platform's grace is a fixed, unconfigurable 10 s
 * (plan row 4.9), and a drain has other work to finish inside that window. At a
 * deliberately pessimistic 1 MB/s client downlink, 8 MiB takes about 8 s — the
 * largest object that plausibly completes inside the shortest grace the fleet
 * runs with.
 *
 * Below it, proxying is the better route and stays the default: it keeps the
 * ETag/304 round trip, the per-tenant metering and one origin for the client,
 * and a sub-8-MiB transfer that dies on a scale-in costs a retry, not a
 * download. The number is `storage.signedDownloadMinBytes` so a deployment with
 * a different drain budget can move it without touching this file.
 */
export const SIGNED_DOWNLOAD_MIN_BYTES = 8 * 1024 * 1024

/**
 * How long a minted URL stays usable.
 *
 * Sixty seconds is the time a client needs to *start* the transfer, not to
 * finish it: S3 and GCS check the signature when the request is received, and a
 * GET that has begun runs to completion however long the bytes take. So the
 * capability window is the handover, and nothing is gained by widening it — a
 * client that comes back later (a resumed download, a re-opened tab) asks the
 * API again and is authorised again.
 *
 * Deliberately a constant rather than configuration: it is the lifetime of a
 * bearer capability that bypasses every check the API makes, which is not a
 * knob an operator should reach for while tuning something else.
 */
export const SIGNED_DOWNLOAD_EXPIRY_SECONDS = 60

/**
 * The two ways a download route can answer. `attachment` is the row the
 * authorisation check already passed — its `filename`, `mime` and `sizeBytes`
 * drive the headers and the ETag on both arms, so the two answers describe the
 * same bytes.
 */
export type AttachmentDownload =
  | { kind: 'stream'; stream: Readable; attachment: Attachment }
  | {
      kind: 'redirect'
      url: string
      expiresInSeconds: number
      attachment: Attachment
    }

/**
 * Choose the route for one already-authorised attachment.
 *
 * Returns `null` only when the bytes are gone — a signing failure is never a
 * failure of the download, it is a proxy. That is the whole contract: a
 * `filesystem` backend has no `signedDownloadUrl` at all, a deployment that has
 * not declared a client-reachable object store has none either, and a store
 * that is reachable but refuses to sign right now throws into the `catch`
 * below. All three end at the same stream the API has always served.
 */
export const resolveAttachmentDownload = async (
  storage: Storage,
  attachment: Attachment,
  options: { minBytes: number },
): Promise<AttachmentDownload | null> => {
  const sign = storage.signedDownloadUrl?.bind(storage)
  if (sign && attachment.sizeBytes >= BigInt(options.minBytes)) {
    try {
      const url = await sign(attachment.storageKey, {
        disposition: attachmentDisposition(attachment.mime),
        expiresInSeconds: SIGNED_DOWNLOAD_EXPIRY_SECONDS,
        filename: attachment.filename,
        mime: attachment.mime,
      })
      return {
        attachment,
        expiresInSeconds: SIGNED_DOWNLOAD_EXPIRY_SECONDS,
        kind: 'redirect',
        url,
      }
    } catch (error) {
      // Never the URL, only that signing failed: the URL is the capability.
      console.error(
        `[files] signed download unavailable for attachment ${attachment.id}, `
        + `proxying instead: ${String(error)}`,
      )
    }
  }
  const stream = await storage.getStream(attachment.storageKey)
  return stream ? { attachment, kind: 'stream', stream } : null
}
