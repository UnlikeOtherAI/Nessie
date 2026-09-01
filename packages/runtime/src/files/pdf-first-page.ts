import { PDFiumLibrary } from '@hyzyla/pdfium'

/**
 * Rasterize the first page of a PDF to a raw RGBA bitmap, for the attachment
 * thumbnail pipeline (see ./thumbnail.ts).
 *
 * PDFium (BSD-3/Apache-2.0) via the MIT `@hyzyla/pdfium` WASM wrapper: zero
 * native dependencies, so the API/worker image stays architecture-independent.
 * MuPDF and Poppler are AGPL/GPL and disqualified; pdf.js + @napi-rs/canvas
 * would add ~60 MB of per-arch native binaries.
 *
 * Everything here is a guard. A PDF is attacker-supplied input handed to a C++
 * parser compiled to WASM, so this module owns the blast radius:
 *  - the library is initialized once per process and renders are serialized —
 *    the WASM module is single-threaded shared state and cleanup crosses an
 *    await, so two concurrent renders would interleave on one heap;
 *  - the render scale is derived from the page's own size and clamped, because
 *    a 448-byte PDF may legally declare a 14400x14400 MediaBox (a fixed scale
 *    of 2 would ask for ~3.3 GB of pixels);
 *  - the WASM heap only ever grows, so the pixel clamp — not the timeout — is
 *    the real protection;
 *  - a zero-page document is rejected explicitly: `getPage(0)` does not throw
 *    on one, it renders uninitialized memory.
 *
 * Encrypted or corrupt PDFs make `loadDocument` throw; the caller degrades to
 * "no thumbnail" rather than failing an upload, and no password is ever asked.
 */

// A PDF larger than this is not worth a preview; it also bounds what is
// buffered before the WASM heap is touched.
export const PDF_MAX_INPUT_BYTES = 100 * 1024 * 1024

// Render bounds. MAX_PIXELS is the binding constraint for pathological page
// geometry; MAX_EDGE keeps a long thin page from becoming a single huge strip.
const MAX_EDGE = 2048
const MAX_PIXELS = 4_000_000
const MAX_SCALE = 2

// Last-ditch signal that a render is pathological. The render itself cannot be
// interrupted, so this only releases the caller (see renderPdfFirstPage).
const RENDER_TIMEOUT_MS = 10_000

export type RawBitmap = {
  data: Buffer
  width: number
  height: number
}

let libraryPromise: Promise<PDFiumLibrary> | null = null

// One library per process. Cached as the promise, not the result, so
// concurrent first callers cannot each initialize a module.
const getLibrary = (): Promise<PDFiumLibrary> => {
  libraryPromise ??= PDFiumLibrary.init().catch((error: unknown) => {
    // Let a later call retry a transient init failure.
    libraryPromise = null
    throw error
  })
  return libraryPromise
}

// Renders run one at a time. The chain advances only when a task has fully
// settled (including its `doc.destroy()`), even if the caller already gave up
// on it, so a timed-out render can never overlap the next one.
let renderChain: Promise<unknown> = Promise.resolve()

const serialize = <T>(task: () => Promise<T>): Promise<T> => {
  const run = renderChain.then(task, task)
  renderChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// Largest scale that keeps the rasterized page inside both bounds. Returns
// null for a page whose declared size is unusable or would rasterize to
// nothing.
const clampScale = (width: number, height: number): number | null => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }
  const scale = Math.min(
    MAX_SCALE,
    MAX_EDGE / Math.max(width, height),
    Math.sqrt(MAX_PIXELS / (width * height)),
  )
  if (!Number.isFinite(scale) || scale <= 0) {
    return null
  }
  // A page so large that even the clamped scale renders sub-pixel is not
  // previewable.
  return Math.round(width * scale) >= 1 && Math.round(height * scale) >= 1 ? scale : null
}

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('pdf render timed out')), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * First page of `input` as a raw RGBA bitmap, or null when it cannot be
 * rendered safely (too large, encrypted, corrupt, zero pages, absurd
 * geometry). Never throws for bad input.
 *
 * The bitmap option is spelled "BGRA" upstream but the wrapper passes
 * FPDF_REVERSE_BYTE_ORDER, so the buffer really is RGBA — do not swap channels.
 */
export const renderPdfFirstPage = async (input: Buffer): Promise<RawBitmap | null> => {
  if (input.byteLength === 0 || input.byteLength > PDF_MAX_INPUT_BYTES) {
    return null
  }

  const task = async (): Promise<RawBitmap | null> => {
    const library = await getLibrary()
    const document = await library.loadDocument(input)
    try {
      // Explicit: getPage(0) on a zero-page document does not throw.
      if (document.getPageCount() < 1) {
        return null
      }
      const page = document.getPage(0)
      const { originalWidth, originalHeight } = page.getOriginalSize()
      const scale = clampScale(originalWidth, originalHeight)
      if (scale === null) {
        return null
      }
      const rendered = await page.render({ render: 'bitmap', scale })
      if (rendered.width < 1 || rendered.height < 1) {
        return null
      }
      // Defensive: only a 4-channel buffer can be handed on as RGBA.
      if (rendered.data.length !== rendered.width * rendered.height * 4) {
        return null
      }
      return {
        data: Buffer.from(rendered.data),
        height: rendered.height,
        width: rendered.width,
      }
    } finally {
      document.destroy()
    }
  }

  try {
    return await withTimeout(serialize(task), RENDER_TIMEOUT_MS)
  } catch {
    // Encrypted, corrupt, or pathological — the caller stores no thumbnail.
    return null
  }
}
