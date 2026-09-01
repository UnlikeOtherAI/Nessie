# Attachment thumbnails, previews, and the full-size viewer

Status: implemented (2026-08-06).

The chat feed painted full-resolution originals into a 320-pixel box, eagerly,
for every message. A 4 MB phone photo transferred 4 MB to draw a thumbnail, and
nothing about that transfer was cacheable. This is what changed and why.

## The four measured problems

Thumbnails alone would have left most of the waste in place. All four were
verified against the running app before any code was written.

1. **`GET /api/attachments/:id` sent no `Cache-Control`, `ETag`, or
   `Last-Modified`.** The browser HTTP cache could neither serve nor revalidate,
   so every render refetched the full original — measured on a 550 KB PNG as a
   full 200 every single time.
2. **`<MessageAttachments>` was mounted for every message row** and fired
   `GET /api/messages/:id/attachments` from a raw effect. A 200-message channel
   issued 200 requests to learn that 199 of them had nothing. The message
   contract carried no attachment count, so the client could not know better.
3. **Originals were painted at full resolution**, eagerly, with no
   `loading="lazy"` and no IntersectionObserver anywhere in the admin.
4. **Object URLs were per-component-instance** and revoked on unmount, so a tab
   switch, a channel switch, or the 30-minute token rotation refetched
   everything.

## What was built

### Caching and counts

Attachment bytes are immutable — an id is minted per stored object and content
never changes, because an "edit" is a fresh upload with a fresh id. So the
download helper now sends `private, max-age=31536000, immutable`, a strong
`ETag` over `id + sizeBytes`, and `Last-Modified`, and answers `If-None-Match`
with a 304. It lives in the one shared `streamAttachmentDownload`, so the
knowledge-base download routes inherit it.

`private` was deliberate: the bytes are tenant-scoped and must never enter a
shared proxy cache. RFC 9111 §3.5 says a cache must not store a response to a
request carrying `Authorization` unless the response names `public`, `s-maxage`,
or `must-revalidate` — the first two invite shared caches in, which is exactly
what `private` rules out. We added `must-revalidate` on that reasoning and then
tested it: Chromium stores and serves these responses from its private cache
without it. The directive was removed rather than kept "just in case".

The transfer-usage event moved into the same helper. A 304 moves no bytes and
must not be metered as though it did, and putting that rule in the one place all
three download routes pass through means it cannot be forgotten in a fourth.

`ThreadMessageRecord` gained `attachmentCount`, sourced from a single
`prisma.attachment.groupBy` per page. There is deliberately **no** Prisma
relation on `Attachment`: its `messageId` is a bare indexed column with no
foreign key, and adding a relation would change delete semantics for a
performance win that a grouped query already delivers. The field is optional, and
absent means *unknown* — the client then fetches, so a missing count can never
hide a real attachment.

### Thumbnails at the FileService chokepoint

Every preview is derived, stored, metered, and freed inside the one
`FileService`. Two paths, one implementation
(`packages/runtime/src/files/thumbnail.ts`):

- **Inline**, in the store path, for raster images — derived from the buffer the
  EXIF strip step is already holding, so there is no second read and no queued
  job for the overwhelmingly common case of someone posting a photo.
- **Queued**, via the `attachment.thumbnail` worker job, for everything that
  path cannot buffer: PDFs, animated or exotic images (GIF/AVIF/TIFF/SVG),
  images above the 50 MiB strip threshold, and organizations that opted out of
  metadata stripping.

Output is a single WebP with a 640-pixel long edge, stored beside the original
as `<storageKey>.thumb.webp`.

Two decisions inside the renderer were driven by bugs found in verification:

- The store pipeline decodes with sharp's `animated: true`, which presents an
  animated WebP as a vertically stacked filmstrip. The thumbnail decodes
  *without* it, so an animated image previews as frame 0 rather than as a tall
  smear of frames.
- The tight 4 megapixel decode budget applies to **vector** sources only. An SVG
  can declare a gigapixel raster from a few hundred bytes, and sharp's default
  ceiling of 268 MP is no protection. A raster is bounded by its own stored
  pixels and has already survived a full decode in the strip step — applying the
  vector budget to it silently dropped the preview for an ordinary 12 MP phone
  photo, which is precisely the upload this feature exists for. Vectors are also
  flattened onto white (they assume a page); rasters keep their alpha, so a
  transparent logo previews as a transparent logo.

### Why PDFium

PDF first pages rasterize through `@hyzyla/pdfium` — an MIT wrapper over
BSD-3/Apache-2.0 PDFium, compiled to WebAssembly.

- **MuPDF and Poppler are AGPL/GPL** and disqualified for a self-hosted product.
- **pdf.js + `@napi-rs/canvas`** works but adds roughly 60 MB of per-architecture
  native binaries to the image.
- PDFium as WASM has **zero native dependencies**, so the API and worker images
  stay architecture-independent, which matters for a product that ships as
  containers to other people's infrastructure.

A PDF is attacker-supplied input handed to a C++ parser, so
`packages/runtime/src/files/pdf-first-page.ts` is mostly guards, each one a
verified failure mode rather than defensive decoration:

| Guard | Why it exists |
| --- | --- |
| Explicit `getPageCount() < 1` check | `getPage(0)` on a zero-page document does **not** throw. It renders uninitialized memory. |
| Scale clamped from `getOriginalSize()` (max edge 2048, max 4 MP, max scale 2) | A 448-byte PDF may legally declare a 14400×14400 MediaBox. At a fixed scale of 2 that requests ~3.3 GB of pixels. |
| One library instance per process, renders serialized to concurrency 1 | The WASM module is single-threaded shared state and cleanup crosses an await; two overlapping renders would interleave on one heap. |
| `doc.destroy()` in `finally`, with the serialization chain awaiting the *real* task | A caller that gives up on a slow render must not let the next one start while the first is still touching memory. |
| 100 MiB input cap, ~10 s wall clock | Bounds the work. The WASM heap never shrinks, so the **pixel clamp** is the real protection; the timeout only releases the caller. |
| Encrypted / corrupt documents | `loadDocument` throws cleanly, the caller records "no thumbnail", and no password is ever requested. |

The bitmap option is spelled `BGRA` upstream, but the wrapper passes
`FPDF_REVERSE_BYTE_ORDER`, so the buffer really is RGBA. No channel swap.

### Accounting and deletion invariants

These are the parts that must never drift:

- **Every preview is quota-gated with its original.** The store path passes
  `bytesWritten + thumbnailBytes` into the authoritative
  `checkStorageQuota` re-check, so a thumbnail can never push an organization
  over its `Budget.storageLimitBytes` after the fact. The async path re-checks
  before claiming.
- **Every preview writes its own signed usage events** — `store.thumbnail` and
  `delete.thumbnail`, rather than being folded into the original's delta. Usage
  is the sum of every row, so the preview's bytes stay individually auditable and
  its `+`/`-` pair nets to zero.
- **Deletion happens in exactly one place.** `FileService.delete` frees both
  objects and writes both negative deltas. Twelve call sites delete attachment
  bytes — including `purgeKnowledgePageFiles` — and all of them funnel through
  that function, so one change covers them all. A leaked thumbnail would be
  storage that nothing accounts for and nothing can ever reach, which is why the
  regression guard is an assertion on the object count before and after.
- **Attaching a preview after the fact is idempotent.** The async claim is an
  `updateMany` conditional on `thumbnailKey` still being null; a loser's object
  is deleted rather than counted, so a re-run cannot double-count bytes.

### Admin

The feed loads the thumbnail, with `loading="lazy"` and `decoding="async"`, and
reserves its box from the thumbnail's own geometry. A PDF that now has a rendered
first page shows it with a small type badge instead of a bare chip. Anything
without a preview keeps the download chip.

Tapping a preview opens the original full size. The viewer is owned by
`ChannelMessageFeed`, not by the message row: there is no portal anywhere in the
admin, so a modal rendered inside a row would inherit its ancestors' stacking and
overflow contexts. Hanging it off the feed is the same seam
`useThoughtProcessDialog` already uses, and it means the reply panel and the
channel info drawers get the viewer without any extra wiring. Escape and backdrop
close it, focus is trapped and restored via the shared `useModalA11y`, the body
scroll is locked while it is open, and Escape stops propagating so one keypress
cannot also close the reply panel underneath.

PDFs open in an `<iframe>` whose blob MIME is pinned to `application/pdf`. That
pin is not cosmetic: a blob URL inherits the admin origin, so trusting the
server-echoed content type would let an uploaded `text/html` named `x.pdf`
execute scripts in the session.

Signed URLs stay out of scope. Auth is bearer-only, so `<img src>` cannot carry
credentials and the blob/object-URL approach stands. With immutable cache headers
the underlying `fetch()` now hits the browser HTTP cache, which was the actual
problem.

## Verification

Headless Playwright, thirteen scenarios, all passing. Screenshots in
`e2e/screenshots/2026-08-05-attachment-thumbnails/` (gitignored).

| Scenario | Measured result |
| --- | --- |
| 11.6 MB / 4000×3000 photo uploaded | Thumbnail generated inline: 42,168 B, 640×480 — **0.36 % of the original** |
| Feed render | Fetched the thumbnail (42,468 B off the network), fetched the 11,586,866 B original **0 times** — 275× less data to paint the same box |
| Reload | 2 thumbnail fetches delivering 84,336 B of body for **0 B off the network** (Resource Timing `transferSize`) |
| Per-message attachment fetches | 31 rows rendered, 6 messages with no files, **0** attachment fetches for them (previously one per rendered row, unconditionally) |
| PDF upload | `thumbnailStatus: pending` on upload, worker rendered a 3,564 B first-page WebP; badge and page visible in the feed |
| `zero-page.pdf` (124 B) | No preview, recorded unavailable, no crash |
| `huge-mediabox.pdf` (198 B, 14400×14400 declared) | Clamped to a 790 B preview; API and worker survived |
| Viewer | Opens the original, body scroll locked, Escape closes and restores focus, scroll lock released |
| Viewer from the reply panel | Opens; Escape closes only the viewer, panel stays open |
| Viewer at 1680 / 1100 / 760 px | Renders, no horizontal page overflow |
| Staged-upload delete | Original and thumbnail both 404 afterwards; ledger `+`/`-` pairs asserted in `api/test/message-attachments.test.ts` |

The PDF viewer screenshot shows a blank page: the headless Chromium shell has no
PDF plugin. The iframe is present and correctly typed; this is a headless
limitation, not a product behaviour.

Automated coverage: `packages/runtime/test/pdf-thumbnail.test.ts` (zero-page,
huge MediaBox, long-thin, encrypted, corrupt, oversized, concurrent renders, SVG
budget, 12 MP photo, alpha handling), `file-service.test.ts` and
`file-service-strip-metadata.test.ts` (store/delete object counts, ledger
operations, animated geometry, fail-open), and `api/test/message-attachments.test.ts`
(304 revalidation, thumbnail ACL including the knowledge-base refusal,
`attachmentCount`, usage events).

## Follow-ups, deliberately not built

- **No backfill.** Attachments stored before this feature have no thumbnail and
  fall back to the original. A backfill job would need to re-read every existing
  blob; worth doing only if the fallback proves expensive in practice.
- **Signed or cookie-based media URLs**, which would let `<img src>` fetch
  directly and remove the blob indirection entirely.
- **Service-worker caching** for offline and cross-session persistence.
- **Video poster frames** — `ffmpeg-static` is GPL-3.0 and disqualified. Needs a
  differently-licensed decoder or a service boundary.
- **Office document previews** — LibreOffice headless is a 500 MB+ image
  addition; belongs behind a service boundary, not in the API image.
- **Gallery navigation** (previous/next within a message) in the viewer.
- **Feed virtualization** — lazy loading fixed the bytes, not the DOM size.
- **Avatar fetch deduplication.** A single channel render was measured issuing
  78 requests to `/api/users/:id/avatar`, all 404 in this environment. Unrelated
  to attachments but the same class of waste.
- **Agent-side attachment visibility** — agents still cannot see message
  attachments.
