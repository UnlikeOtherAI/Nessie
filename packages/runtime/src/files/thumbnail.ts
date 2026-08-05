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

// Decode budget for sources whose pixel count is not otherwise bounded (most
// importantly SVG, which sharp renders via librsvg at a caller-chosen size and
// whose default limit is 268 MP).
const MAX_DECODE_PIXELS = 4_000_000

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
 * Thumbnail for raster/vector image bytes.
 *
 * Deliberately decoded WITHOUT sharp's `animated: true`: the store path uses it
 * (to preserve animation), and an animated WebP/GIF decoded that way is a
 * vertically stacked filmstrip — inheriting that geometry would make every
 * animated thumbnail a tall smear of frames. Reading frame 0 is what a preview
 * wants anyway.
 *
 * `limitInputPixels` is pinned to the decode budget rather than sharp's
 * default, which matters most for SVG (an inch-sized document can declare a
 * gigapixel raster). Passing a Buffer — never a path — keeps librsvg from
 * resolving anything off the filesystem.
 */
export const renderImageThumbnail = async (
  input: Buffer,
): Promise<GeneratedThumbnail | null> => {
  try {
    return await encodeThumbnail(
      sharp(input, { limitInputPixels: MAX_DECODE_PIXELS }).flatten({
        background: '#ffffff',
      }),
    )
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
    return renderImageThumbnail(input)
  }
  return null
}
