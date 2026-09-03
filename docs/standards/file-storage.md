# File storage & accounting — single chokepoint

Authoritative standard, moved verbatim out of
[`CLAUDE.md`](../../CLAUDE.md) so it is read when the work touches this area
rather than loaded into every session. `CLAUDE.md` carries the one-line
summary and points here; **this file is the rule**.


Authoritative rules (one `FileService` for all blob work, accounting in every
op, streaming, EXIF strip, thumbnails, images in agent context):
`AGENTS.md` → "File storage & accounting". Facts not restated there:

- Thumbnails: raster images are generated inline at store time from the buffer
  the strip step already holds, decoded WITHOUT `animated: true` so an
  animated image previews as frame 0; PDF first pages rasterize via
  `@hyzyla/pdfium` (MIT wrapper over BSD-3/Apache-2.0 PDFium — MuPDF/Poppler
  are AGPL/GPL and ffmpeg is GPL-3.0, so all are disqualified). Served at
  `GET /api/attachments/:id/thumbnail`. `ThreadMessageRecord.attachmentCount`
  exists so the feed does not fetch an attachment list per message.
- Images in agent context: the inventory line looks like
  `[attached: gallus.png (image/png, 812 KB, id=att-1)]`; inlined images are
  `{ mime, dataBase64 }` on `ProviderMessage.images` and count ~1500 tokens
  each for the context window; `openai`/`openai-compatible` emit multi-part
  `image_url` data URIs. PDFs are named, not read.
- Backend = S3-compatible MinIO in production, `filesystem` in local dev. KB
  file nodes (`KnowledgePage.kind = file`) and page attachments live alongside
  documents — see
  [docs/knowledge-base-requirements.md](../knowledge-base-requirements.md).
- Specs:
  [docs/plans/2026-08-06-attachment-thumbnails-and-previews.md](../plans/2026-08-06-attachment-thumbnails-and-previews.md),
  [docs/plans/2026-08-07-images-in-agent-context.md](../plans/2026-08-07-images-in-agent-context.md).
