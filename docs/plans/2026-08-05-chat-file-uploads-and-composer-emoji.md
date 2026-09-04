# Chat file uploads + composer emoji picker (2026-08-05)

Wires the two inert composer toolbar buttons into real features and adds
drag-and-drop upload targets to the chat surfaces. Everything routes through the
existing `FileService` chokepoint and the existing `POST /api/uploads` +
`attachmentIds` message-create contract; rendering already existed
(`MessageAttachments`), so this plan is composer/UI wiring plus a few narrow API
contract changes.

## What shipped

### API

- `CreateThreadMessageBodySchema`: `content` is now optional (still capped at
  `CHAT_MESSAGE_MAX_CHARS`); `attachmentIds` is capped at
  `MESSAGE_ATTACHMENT_LIMIT` (10); a cross-field refine requires text or at
  least one attachment. Attachment-only posts store `content = ''`.
- Attachment linking at message create is now **uploader-scoped**
  (`uploaderId = sender` in the `updateMany` filter), so one member cannot link
  another member's pending upload to their own message.
- `DELETE /api/attachments/:id`: discards the uploader's **own, still-unlinked**
  upload (the staged-then-removed composer case) through `fileService.delete`,
  which also writes the `-bytes` `StorageUsageEvent`. Anything referenced by a
  message, KB page, org logo, user/agent avatar, or feedback item is refused
  (404 for non-eligible rows, 409 `ATTACHMENT_IN_USE` on FK-protected rows).
- "Also send to #channel" broadcast copies of an attachment-only reply get a
  fallback content line (`ATTACHMENT_ONLY_BROADCAST_CONTENT`) instead of an
  empty bubble — copies do not carry attachments.
- Shared constants `MESSAGE_UPLOAD_MAX_BYTES` (25 MiB) and
  `MESSAGE_ATTACHMENT_LIMIT` moved to `@nessie/schemas` so the admin pre-flight
  check and the server enforce the same numbers.
- Tests: `api/test/message-attachments.test.ts` covers attachment-only sends,
  the text-or-attachment refine, the id cap, uploader-scoped linking, and the
  delete endpoint's eligibility rules.

### Admin

- `useComposerAttachments` (new): staged-file state machine — client-side
  validation (size/count), per-file XHR upload with progress
  (`uploadFileWithProgress` → `POST /api/uploads`), remove (server-side discard
  via the new DELETE), abandoned-mid-upload discard, and `clearStaged()` only
  after a successful send so failed sends keep files for retry.
- `ChannelComposer`: paperclip wired to a hidden multi-`<input type="file">`;
  `ComposerAttachments` chip strip (filename, size, progress bar, inline
  `role="alert"` errors, remove) rendered above the toolbar; send enabled when
  there is text **or** at least one uploaded file and no upload is in flight.
  The two hand-rolled inline SVG icons were replaced with FontAwesome
  (`faPaperclip`, `faFaceSmile`).
- `ComposerEmojiButton` (new): reuses the shared `EmojiPickerPanel` (same one as
  message reactions) in a popover above the toolbar, mirroring the reaction
  picker's dismissal (outside pointerdown, Escape, ARIA dialog wiring); selects
  insert at the caret via the `MentionInput` handle and refocus the input. New
  `.admin-compose-emoji(-menu)` styles anchor it upward/left so it fits inside
  the thread panel at every width.
- Drag-and-drop: `useFileDrop` moved to `admin/src/hooks/` and generalised to
  `File[]` (KB consumers keep single-file behaviour via a `firstFileOnly`
  adapter); `DropZoneOverlay` moved to `components/shared/` and gained a
  `label`. Drop hosts: the main channel column (`ChannelsPage`, "Drop files to
  attach") and the reply-thread panel `<aside>` (`ThreadReplyPanel`, "Drop
  files to reply with", disabled for deleted roots). The two hosts are DOM
  siblings, so drops cannot double-fire in any of the three panel modes.
- Bug fixed in passing: the oversize-paste `sendAsFile` path now spreads
  `getSendExtras()`, so "send as file" from the thread panel replies into the
  thread instead of posting top-level.

## Verification (2026-08-05, headless Playwright, dev-login)

12/12 scenarios pass against `http://localhost:5455`; screenshots in
`e2e/screenshots/2026-08-05-chat-uploads-emoji/` (gitignored, local):

1. channel page + composer render; 2. emoji picker opens in main composer;
3. emoji inserts at caret and sends; 4. paperclip stages a PNG + txt with
progress, attachment-only send renders inline image + download chip;
5. drag-drop over main chat shows the overlay, drop stages, remove discards
server-side; 6–8. thread panel at 1680 px (push): drop-to-reply overlay,
attachment reply sends and renders; 9. emoji popover fits the thread composer;
10. panel overlay mode at 1100 px; 11. fullscreen at 760 px with a working
drop; 12. a 26 MiB file is rejected client-side with an inline error and no
network call.

### Fix: stretched inline images (post-merge)

Reported from production: a posted image rendered squashed. `MessageAttachments`
lays attachments out in a `flex flex-col` column, whose default
`align-items: stretch` widened the `<img>` to the full message column while
`max-h-80` capped its height — breaking the ratio. The image now carries
`h-auto w-auto self-start object-contain` plus the stored intrinsic
`width`/`height` (which also reserves the box before the bytes load). Verified
by measuring rendered vs `naturalWidth`/`naturalHeight`: a 600×120 source
renders 602×122 (the 2px is the border) and a 300×900 source renders 108×320,
i.e. height-capped with width scaled — screenshots `16-aspect-ratio-fixed.png`
and `17-aspect-ratio-portrait.png`.

## Follow-ups (deliberately not built)

- The per-message `GET /api/messages/:id/attachments` N+1 (embed attachments in
  message records / realtime payloads instead).
- Thumbnails, `Range`/`ETag` on downloads, paste-to-upload, upload rate
  limiting, GC for orphaned unlinked uploads.
