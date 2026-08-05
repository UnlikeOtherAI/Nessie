import sharp, { type Sharp } from 'sharp'

import { renderPdfFirstPage } from './pdf-first-page.js'

/**
 * Thumbnail derivation for uploaded files, used from two places:
 *  - inline, at the FileService store chokepoint, for the raster images that
 *    are already buffered for EXIF stripping (see ./strip-image-metadata.ts);
 *  - from the `attachment.thumbnail` worker job, for everything that cannot be
 *    buffered on the upload path (PDFs, GIF/HEIC/SVG, images above the strip
 *    threshold, and orgs that opted out of stripping).
 *
 * One small WebP per attachment, stored next to the original. Nothing here
 * throws for bad input: an undecodable file simply has no thumbnail.
 */

// Long edge of the generated preview. Comfortably above the ~320px box the
// chat feed paints, so it stays crisp on a 2x display without approaching the
// cost of the original.
export const THUMBNAIL_MAX_EDGE = 640
export const THUMBNAIL_MIME = 'image/webp'

// Decode budget for VECTOR sources, whose pixel count is chosen by the
// renderer rather than fixed by the file: an inch-sized SVG can declare a
// gigapixel raster, and sharp's default ceiling (268 MP) is no protection.
// Raster images keep that default — they are bounded by their own stored
// pixels, they have already survived a full decode in the strip step, and an
// ordinary 12 MP phone photo must obviously still get a preview.
const MAX_VECTOR_PIXELS = 4_000_000

const VECTOR_MIMES = new Set(['image/svg+xml'])

// Rasterizable-but-not-strippable inputs the async path can still preview.
// (JPEG/PNG/WebP are handled inline at store time; they are listed so a
// re-queued job can still produce a thumbnail for an org that opted out of
// metadata stripping.)
const THUMBNAILABLE_IMAGE_MIMES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/tiff',
  'image/webp',
])

export const PDF_MIME = 'application/pdf'

export type GeneratedThumbnail = {
  data: Buffer
  width: number
  height: number
  mime: string
}

/** True when a thumbnail could plausibly be derived from this content type. */
export const isThumbnailableMime = (mime: string): boolean =>
  mime === PDF_MIME || THUMBNAILABLE_IMAGE_MIMES.has(mime)

// Shared encode tail: downscale to the preview box and encode as WebP. Never
// enlarges — a 64x64 avatar stays 64x64 rather than becoming a blurry 640px.
const encodeThumbnail = async (pipeline: Sharp): Promise<GeneratedThumbnail | null> => {
  const { data, info } = await pipeline
    .resize(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 75 })
    .toBuffer({ resolveWithObject: true })
  if (data.length === 0 || info.width < 1 || info.height < 1) {
    return null
  }
  return { data, height: info.height, mime: THUMBNAIL_MIME, width: info.width }
}

/**
 * Thumbnail for image bytes.
 *
 * Deliberately decoded WITHOUT sharp's `animated: true`: the store path uses it
 * (to preserve animation), and an animated WebP/GIF decoded that way is a
 * vertically stacked filmstrip — inheriting that geometry would make every
 * animated thumbnail a tall smear of frames. Reading frame 0 is what a preview
 * wants anyway.
 *
 * A vector source is decoded under the tight pixel budget and flattened onto
 * white (it usually assumes a page); a raster keeps its alpha, so a transparent
 * logo previews as a transparent logo. Input is always a Buffer, never a path,
 * so librsvg can never resolve anything off the filesystem.
 */
export const renderImageThumbnail = async (
  input: Buffer,
  options: { vector?: boolean } = {},
): Promise<GeneratedThumbnail | null> => {
  try {
    const pipeline = options.vector
      ? sharp(input, { limitInputPixels: MAX_VECTOR_PIXELS }).flatten({ background: '#ffffff' })
      : sharp(input)
    return await encodeThumbnail(pipeline)
  } catch {
    return null
  }
}

/**
 * Thumbnail of a PDF's first page. The raw RGBA bitmap comes back from PDFium
 * already clamped to a sane pixel budget; flattening onto white gives a page
 * that reads as paper rather than as a transparent checkerboard.
 */
export const renderPdfThumbnail = async (
  input: Buffer,
): Promise<GeneratedThumbnail | null> => {
  const bitmap = await renderPdfFirstPage(input)
  if (!bitmap) {
    return null
  }
  try {
    return await encodeThumbnail(
      sharp(bitmap.data, {
        raw: { channels: 4, height: bitmap.height, width: bitmap.width },
      }).flatten({ background: '#ffffff' }),
    )
  } catch {
    return null
  }
}

/** Dispatch on content type; null when this kind has no preview. */
export const renderThumbnail = async (
  mime: string,
  input: Buffer,
): Promise<GeneratedThumbnail | null> => {
  if (mime === PDF_MIME) {
    return renderPdfThumbnail(input)
  }
  if (THUMBNAILABLE_IMAGE_MIMES.has(mime)) {
    return renderImageThumbnail(input, { vector: VECTOR_MIMES.has(mime) })
  }
  return null
}
