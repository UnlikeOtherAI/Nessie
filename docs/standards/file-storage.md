# File storage & accounting — single chokepoint

Authoritative standard. `AGENTS.md` → "File storage & accounting" carries the
one-line summary and points here; **this file is the rule.**

- **All blob file operations** — store, stream, download, delete, version — MUST go through the one `@nessie/runtime` `FileService` (`createFileService`). Never call `getStorage` / `storage.*` or `prisma.attachment` for file bytes from anywhere else (routes, worker tools, services). Build it once per process from `config.storage`. Attachment→message linking (`Attachment.messageId`) carries no bytes and no accounting delta, so it is not a `FileService` operation: it is an ordinary `prisma.attachment.updateMany` write, guarded by the message-visibility check on the target thread (see `api/src/routes/thread-message-create.ts`).
- **Storage accounting is part of the file op, not optional.** Every store increments and every delete decrements the `StorageUsageEvent` ledger (signed-byte deltas). This is what keeps per-organization / team / space / uploader usage always known, and it is enforced by the `FileService` so it can never be skipped. Uploads are quota-gated via `Budget.storageLimitBytes`.
- Uploads can be up to `NESSIE_MAX_UPLOAD_BYTES` (default 5 GiB), so file paths must **stream** (never `toBuffer`/`readFile`). `Attachment.sizeBytes` is a `BigInt`; serialize it as a string at API boundaries.
- JPEG/PNG/WebP uploads have EXIF/GPS metadata stripped at the `FileService` store chokepoint (EXIF orientation applied to the pixels first, ICC profiles preserved, accounting records the post-strip size); orgs opt out via `Organization.stripImageMetadata`, and images over 50 MiB or undecodable pass through unchanged to keep uploads streaming.
- **A previewable upload also owns a thumbnail** (`<storageKey>.thumb.webp`), derived at the same chokepoint: inline for raster images, via the `attachment.thumbnail` worker job for PDFs (first page, `@hyzyla/pdfium` — pure WASM, no native deps; AGPL/GPL renderers are disqualified), animated/exotic images, oversized images, and strip opt-outs. It is quota-gated with the original, carries its own `store.thumbnail` / `delete.thumbnail` usage events, and is freed by `FileService.delete` — the single place attachment bytes are removed, so nothing can leak it. Generation failures are never fatal (`thumbnailStatus = unavailable`, clients fall back to the original); existing attachments are not backfilled. Attachment downloads and thumbnails are served with `private, max-age=1y, immutable` + a strong `ETag`, with `If-None-Match` answered as a 304, because attachment bytes are immutable. Spec: [docs/plans/2026-08-06-attachment-thumbnails-and-previews.md](../plans/2026-08-06-attachment-thumbnails-and-previews.md).
- **A run's context window carries its messages' attachments.** Every turn gets an inventory line appended at render time (kept beside `Message.content`, never inside it, so the prompt builder's raw-content comparison still matches), and `user` turns carry inlined image bytes on `ProviderMessage.images`. Bytes come from the same `FileService` chokepoint — original for a PNG/JPEG/WebP/GIF ≤ 4 MiB, else the stored `.thumb.webp`, else nothing — capped at 6 images per prompt (newest first), non-fatal on failure, and estimated for the context window. Whether they reach the wire is the connector's call, gated on its own truthful `supportsVision` (`openai`/`openai-compatible` yes; `deepseek`/`kimi` no, keeping the inventory line). The engagement orchestrator reads the same line so an image-only post can start a run; the judgement itself stays model-made. Logic lives in `worker/src/run/message-attachments.ts` — do not fetch attachment bytes for prompts anywhere else. Spec: [docs/plans/2026-08-07-images-in-agent-context.md](../plans/2026-08-07-images-in-agent-context.md).
- Production storage is S3-compatible (self-hosted MinIO); local dev defaults to `filesystem`. See [docs/deployment.md](../deployment.md).

Details beyond the rules above:

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
- KB file nodes (`KnowledgePage.kind = file`) and page attachments live
  alongside documents — see
  [docs/knowledge-base-requirements.md](../knowledge-base-requirements.md).
- **One deliberate exception:** `agent_browser_tabs.screenshot` holds the
  product's own JPEG of each tab an agent's browser was left on (≤ 400 KB,
  ≤ 12 per browser, overwritten on every capture). It is a snapshot the
  product makes for its own screen, not a person's file, so it does not pass
  through `FileService`: storage accounting under-reports by at most that
  bound per browser, and database dumps carry page imagery of possibly
  signed-in content — which is why the rows are read only through the
  browser's audience rule (`viewerMaySeeAgentBrowser`).
