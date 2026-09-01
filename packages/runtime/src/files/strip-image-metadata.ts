import { Readable } from 'node:stream'

import sharp from 'sharp'

import { type GeneratedThumbnail, renderImageThumbnail } from './thumbnail.js'

/**
 * Privacy stripping for uploaded images, applied at the FileService store
 * chokepoint so every upload route inherits it.
 *
 * What it does for JPEG/PNG/WebP: applies the EXIF orientation to the pixels
 * (so images do not appear rotated after stripping), then re-encodes without
 * EXIF/XMP metadata (GPS, device ids, timestamps) while preserving the ICC
 * color profile. Re-encoding is inherent to orientation normalization; JPEG
 * and WebP are re-encoded at quality 95 to keep the quality loss minimal
 * (PNG is lossless).
 *
 * Bounded memory: uploads may be up to 5 GiB and must never be fully
 * buffered, so only images at or below IMAGE_STRIP_MAX_BYTES are processed.
 * Larger images stream through unchanged (only the first threshold's worth of
 * bytes is ever held, then replayed ahead of the remaining stream). HEIC is
 * not supported by sharp's prebuilt libvips and passes through unchanged, as
 * does anything sharp fails to decode (corrupt or exotic content) — in that
 * case the original bytes are stored untouched rather than failing the
 * upload.
 */

// Only these declared content types are processed; everything else streams
// through untouched.
const STRIPPABLE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])

// Images above this size are passed through unchanged (see module docstring).
export const IMAGE_STRIP_MAX_BYTES = 50 * 1024 * 1024

export const isStrippableImageMime = (mime: string): boolean => STRIPPABLE_MIMES.has(mime)

export type PreparedImageUpload = {
  body: Readable
  // Final pixel dimensions after orientation normalization, set only when the
  // image was actually re-encoded; null when passed through untouched.
  width: number | null
  height: number | null
  // Small WebP preview derived from the same buffered bytes, so the common
  // case (a chat photo) never needs a second decode or a queued job. Null when
  // the image passed through untouched or the preview could not be produced.
  thumbnail?: GeneratedThumbnail | null
}

export const prepareImageUpload = async (body: Readable): Promise<PreparedImageUpload> => {
  // Buffer until EOF or the threshold. Pull via a manual iterator (never
  // `break` a for-await, which would destroy the source stream) so that on
  // oversize the buffered head can be replayed ahead of the still-open rest
  // of the stream — large uploads keep flowing without being held in memory.
  const iterator = body[Symbol.asyncIterator]()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await iterator.next()
    if (done) break
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
    chunks.push(buf)
    total += buf.length
    if (total > IMAGE_STRIP_MAX_BYTES) {
      const head = Buffer.concat(chunks)
      return {
        body: Readable.from(
          (async function* () {
            yield head
            for (;;) {
              const next = await iterator.next()
              if (next.done) return
              yield next.value as Buffer
            }
          })(),
        ),
        width: null,
        height: null,
      }
    }
  }

  const original = Buffer.concat(chunks)
  try {
    const format = (await sharp(original).metadata()).format
    const pipeline = sharp(original, { animated: true })
      .rotate() // bake the EXIF orientation into the pixels before stripping it
      .keepIccProfile()
    if (format === 'jpeg') pipeline.jpeg({ quality: 95 })
    else if (format === 'webp') pipeline.webp({ quality: 95 })
    // png and any mislabeled-but-decodable content keep their input format.
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
    // Derive the preview from the RESULT: already oriented and stripped, so it
    // needs no re-rotate and can never carry back metadata this step removed.
    // renderImageThumbnail swallows its own failures (and decodes frame 0, not
    // the animated filmstrip this pipeline produces), so a preview problem can
    // never cost us the stripped bytes by falling into the catch below.
    const thumbnail = await renderImageThumbnail(data)
    return { body: Readable.from(data), height: info.height, thumbnail, width: info.width }
  } catch {
    // Undecodable content: store the original bytes untouched rather than
    // failing the upload.
    return { body: Readable.from(original), width: null, height: null }
  }
}
