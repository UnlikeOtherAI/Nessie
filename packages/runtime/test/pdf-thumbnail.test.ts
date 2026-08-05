import assert from 'node:assert/strict'
import test from 'node:test'

import sharp from 'sharp'

import { PDF_MAX_INPUT_BYTES, renderPdfFirstPage } from '../src/files/pdf-first-page.js'
import { renderPdfThumbnail, renderThumbnail } from '../src/files/thumbnail.js'

// Hand-written PDFs: every one of these is a real failure mode a user (or an
// attacker) can upload, and none of them may crash, hang, or exhaust memory —
// they must all degrade to "no thumbnail".
const pdf = (body: string): Buffer => Buffer.from(body, 'latin1')

const ONE_PAGE = pdf(`%PDF-1.4
1 0 obj
<</Type/Catalog/Pages 2 0 R>>
endobj
2 0 obj
<</Type/Pages/Kids[3 0 R]/Count 1>>
endobj
3 0 obj
<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>
endobj
trailer
<</Root 1 0 R>>
`)

// Count 0 with an empty Kids array. getPage(0) does NOT throw on this — it
// renders uninitialized memory — so the page count must be checked explicitly.
const ZERO_PAGE = pdf(`%PDF-1.4
1 0 obj
<</Type/Catalog/Pages 2 0 R>>
endobj
2 0 obj
<</Type/Pages/Kids[]/Count 0>>
endobj
trailer
<</Root 1 0 R>>
`)

// A few hundred bytes declaring PDF's maximum legal page size. At a fixed
// scale of 2 this asks for 28800x28800x4 bytes ≈ 3.3 GB of pixels.
const HUGE_MEDIABOX = pdf(`%PDF-1.4
1 0 obj
<</Type/Catalog/Pages 2 0 R>>
endobj
2 0 obj
<</Type/Pages/Kids[3 0 R]/Count 1>>
endobj
3 0 obj
<</Type/Page/Parent 2 0 R/MediaBox[0 0 14400 14400]>>
endobj
trailer
<</Root 1 0 R>>
`)

// Long and thin: the pixel budget alone would allow a 2000x2 strip, so the
// max-edge clamp is what keeps this sane.
const LONG_THIN = pdf(`%PDF-1.4
1 0 obj
<</Type/Catalog/Pages 2 0 R>>
endobj
2 0 obj
<</Type/Pages/Kids[3 0 R]/Count 1>>
endobj
3 0 obj
<</Type/Page/Parent 2 0 R/MediaBox[0 0 12000 20]>>
endobj
trailer
<</Root 1 0 R>>
`)

const ENCRYPTED = pdf(`%PDF-1.4
1 0 obj
<</Type/Catalog/Pages 2 0 R>>
endobj
2 0 obj
<</Type/Pages/Kids[3 0 R]/Count 1>>
endobj
3 0 obj
<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>
endobj
4 0 obj
<</Filter/Standard/V 1/R 2/O<0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20>/U<0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20>/P -1>>
endobj
trailer
<</Root 1 0 R/Encrypt 4 0 R/ID[<0102030405060708090a0b0c0d0e0f10><0102030405060708090a0b0c0d0e0f10>]>>
`)

const CORRUPT = Buffer.from('%PDF-1.4 followed by nothing that parses as a document')

test('renders the first page of an ordinary PDF', async () => {
  const bitmap = await renderPdfFirstPage(ONE_PAGE)
  assert.ok(bitmap, 'a one-page PDF renders')
  // 200x100pt at the clamped scale (2), and RGBA — four bytes per pixel.
  assert.equal(bitmap.width, 400)
  assert.equal(bitmap.height, 200)
  assert.equal(bitmap.data.length, bitmap.width * bitmap.height * 4)

  const thumbnail = await renderPdfThumbnail(ONE_PAGE)
  assert.ok(thumbnail)
  assert.equal(thumbnail.mime, 'image/webp')
  assert.equal(thumbnail.width, 400)
  assert.equal(thumbnail.height, 200)
  assert.equal((await sharp(thumbnail.data).metadata()).format, 'webp')
})

test('a zero-page PDF yields no thumbnail instead of rendering undefined memory', async () => {
  assert.equal(await renderPdfFirstPage(ZERO_PAGE), null)
  assert.equal(await renderPdfThumbnail(ZERO_PAGE), null)
})

test('an absurd MediaBox is clamped, not honoured', async () => {
  const before = process.memoryUsage().rss
  const bitmap = await renderPdfFirstPage(HUGE_MEDIABOX)
  assert.ok(bitmap, 'a legal but enormous page still previews')
  // Inside both the pixel budget and the max-edge bound.
  assert.ok(bitmap.width <= 2048 && bitmap.height <= 2048, `${bitmap.width}x${bitmap.height}`)
  assert.ok(bitmap.width * bitmap.height <= 4_000_000)
  // Nowhere near the ~3.3 GB an unclamped scale of 2 would have asked for.
  assert.ok(process.memoryUsage().rss - before < 512 * 1024 * 1024)

  const thumbnail = await renderPdfThumbnail(HUGE_MEDIABOX)
  assert.ok(thumbnail)
  assert.ok(thumbnail.width <= 640 && thumbnail.height <= 640)
})

test('a long thin page is bounded by the max edge', async () => {
  const bitmap = await renderPdfFirstPage(LONG_THIN)
  assert.ok(bitmap)
  assert.ok(bitmap.width <= 2048, `width ${bitmap.width}`)
  assert.ok(bitmap.height >= 1, 'the short edge survives rounding')
})

test('encrypted and corrupt PDFs degrade instead of throwing', async () => {
  assert.equal(await renderPdfFirstPage(ENCRYPTED), null)
  assert.equal(await renderPdfFirstPage(CORRUPT), null)
  assert.equal(await renderPdfThumbnail(CORRUPT), null)
})

test('empty and oversized inputs are rejected before the library is touched', async () => {
  assert.equal(await renderPdfFirstPage(Buffer.alloc(0)), null)
  // Only the length is inspected, so this never allocates a real 100 MiB doc.
  const oversized = Buffer.alloc(PDF_MAX_INPUT_BYTES + 1)
  assert.equal(await renderPdfFirstPage(oversized), null)
})

test('concurrent renders are serialized and all succeed', async () => {
  // The WASM module is single-threaded shared state; overlapping renders would
  // corrupt each other's heap or crash.
  const results = await Promise.all([
    renderPdfThumbnail(ONE_PAGE),
    renderPdfThumbnail(HUGE_MEDIABOX),
    renderPdfThumbnail(ZERO_PAGE),
    renderPdfThumbnail(CORRUPT),
    renderPdfThumbnail(ONE_PAGE),
  ])
  assert.ok(results[0])
  assert.ok(results[1])
  assert.equal(results[2], null)
  assert.equal(results[3], null)
  assert.ok(results[4])
})

test('renderThumbnail dispatches on mime and ignores kinds with no preview', async () => {
  assert.ok(await renderThumbnail('application/pdf', ONE_PAGE))
  assert.equal(await renderThumbnail('application/zip', ONE_PAGE), null)
  assert.equal(await renderThumbnail('text/plain', Buffer.from('hello')), null)
})

test('an SVG is rasterized within the decode budget', async () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150">'
    + '<rect width="300" height="150" fill="#3366cc"/></svg>',
  )
  const thumbnail = await renderThumbnail('image/svg+xml', svg)
  assert.ok(thumbnail)
  assert.equal(thumbnail.width, 300)
  assert.equal(thumbnail.height, 150)

  // A vector document may declare a gigapixel raster; librsvg must not be
  // allowed to try.
  const gigapixel = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40000" height="40000">'
    + '<rect width="40000" height="40000" fill="#000"/></svg>',
  )
  assert.equal(await renderThumbnail('image/svg+xml', gigapixel), null)
})
