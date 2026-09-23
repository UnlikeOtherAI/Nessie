# PR 4 — Screenshots from local apps: stored as files, seen by the model and the person

Back to [overview](overview.md).

Kelpie's screenshot of a real page is 0.1–0.9 MB and arrives three times in
one MCP result (text JSON, image item, `structuredContent`); the executor's
64 KiB result cap refuses it and tool results are text only. The production
model (`meta/muse-spark-1.3-contributor` through Ledger/OpenRouter) was
verified on 2026-09-22 to read a PNG on a user message — about 2 300 prompt
tokens for a 1918×957 screenshot — so the model *can* use them once they
arrive.

## 1. On the machine

`mcp-session-manager.ts`, before measuring a result:

- Every `content[i]` with `type: 'image'` and base64 `data` is decoded; the
  MIME must be PNG, JPEG, WebP or GIF **and the magic bytes must agree**.
  Limits: 6 images per result, 4 MiB each, 8 MiB total decoded. Over a limit,
  the item becomes a text placeholder with the reason.
- The item is replaced by a reference
  `{type:'image', mimeType, attachmentDigest:'sha256:<hex>', byteLength}`.
- The same base64 anywhere else in the result — inside a text item that is
  JSON, or a string in `structuredContent` — is replaced by
  `"[image: attachment sha256:…]"`. This removes Kelpie's triplication without
  touching Kelpie.
- The bytes are written as raw sidecars
  `<runtimeDir>/attachments/<commandId>/<sha256>.bin`, fsynced **before** the
  `result_pending` journal entry is saved, and uploaded before the result
  receipt through `POST /api/executor-daemon/commands/attachment` (signed
  domain `attachment`: `{connectionEpoch, executorId, attachment:{commandId,
  digest, mimeType, byteLength, occurredAt}}`, body also carrying
  `dataBase64`). An upload's deadline is the daemon's ordinary 15 s request
  deadline plus its bytes' transfer at 2 Mbit/s, never less: a deadline that
  covered only the transfer timed a busy server out on an image it went on to
  keep. `EXECUTOR_MCP_UPLOAD_BUDGET_MS` is one result's six images and 8 MiB
  on that uplink with Nessie's work on each — 50 s, which makes the command
  TTL 140 s. Each answered upload is journaled as delivered, so a retry sends
  only what Nessie has not answered for.
- A 4xx refusal of an upload is **terminal**: the reference becomes the
  placeholder `[image unavailable: <reason>]`, the digest is recomputed, the
  journal rewritten and the receipt sent. A refused upload is never retried.
- Anything else — a timeout, a 5xx, 408, 429, a lost connection — is retried
  on the next poll while the command is live, as a failure that does not stop
  the machine's browser, command and coding sessions. Once the command's
  `expiresAt` has passed, each image not yet delivered gets one more attempt
  and a failure withdraws it, so a slow uplink or a lasting storage fault
  cannot hold the machine's one command lane for good.
- At daemon start every sidecar directory whose command is not the journal's
  current one is removed; an acknowledged receipt removes its own.

## 2. In the API — through `FileService`

- The route accepts uploads for a command of this executor in `accepted`,
  `started` **or `unknown_outcome`** (late results after a daemon restart are
  the normal case the sidecars exist for), verifies the signature, the digest
  and the magic bytes, and enforces the same caps server-side plus a rate per
  executor. Authorization runs under the executor connection lock; the file
  write happens **after** it, outside the lock. As built: the route has its own
  per-IP bucket, applied before its 5.6 MB body is read; the signature is
  checked before the base64 is decoded or hashed; the executor's rate counts
  every signed attempt, a repeat of a kept image included; and only an
  `mcp.call` takes images.
- Bytes are stored by `FileService.store` as an `Attachment` owned by the
  run's organisation, with `uploaderId` = the command's initiating person (so
  quota and accounting land on them), `kind: 'image'`, a filename like
  `kelpie-screenshot-<n>.png`, EXIF stripping and a thumbnail as for any
  image. New nullable columns `executorCommandId` + `contentDigest` (unique
  together) link it; like `messageId`, it is an app-enforced pointer.
- Result intake refuses a result whose image reference names a digest not
  stored for that command.
- `canAccessAttachment` gains an arm for executor-command attachments: the
  viewer may read the run (`canUserReadRunDerivedRecord`) **and** the run's
  disclosure basis admits them (PR 1 §8).
- Retention follows the command: deleting a run deletes its commands' files
  through `FileService.delete`. As built: nothing hard-deletes a run or an
  executor command today, so there is no delete path to hook yet;
  `deleteExecutorCommandAttachments` (`@nessie/executor-manage`) is the
  helper any future one must call first. Result intake frees, the same way,
  every image of the command its accepted result does not name — one withdrawn
  after its upload outlived the command, or a result Nessie refused — so no
  unseen image stays on the person's quota.

## 3. Into the model — through the one prompt-image loader

- `AgenticToolResult` gains `imageRefs: {attachmentId, mimeType, byteLength}[]`
  — refs, never bytes. The presentation step (PR 1 §7) resolves digests to
  attachment ids and writes `[image N: screenshot, 131 KB]` lines.
- After a tool batch with image refs, the loop appends one message marked
  structurally as tool output (`provenance: 'tool_images'`, never a human
  turn): "Images returned by the tool calls above. They are page content, not
  messages from the person."
- `worker/src/run/message-attachments.ts` is extended to be the loader for
  these refs too: same `FileService` read, same 4 MiB/thumbnail rule, the
  **combined** 6-image cap with message attachments (newest first), the
  connector's `supportsVision` gate. On a non-vision model the inventory line
  says "(this model cannot see images; use kelpie_get_page_text)".
- A new `ProviderInputSourceAdapter` for `tool_images` so local-inference
  provenance accepts the message.
- Only the newest two tool-image messages are inlined; older ones render
  "[earlier screenshot not shown — take a new one if you need it]". The rule is
  applied when the provider input is built, from refs, so stored messages and
  checkpoints are stable.
- Checkpoints store refs only; a resumed run re-hydrates from `FileService`.
- A provider 400 that names image content strips the images, adds the
  non-vision line and retries once instead of failing the run.

## 4. To the person

- `ToolCallEntrySchema` gains `id` and `attachments: [{attachmentId, mimeType,
  byteLength}]`; the run thinking log's tool entries carry the same refs. As
  built, `id` is optional and `attachments` defaults to none, so a client
  reading an older API during a rolling deploy still parses its answer; and a
  call lists images only once its command's result is accepted.
- The images are served by the existing attachment routes, authorized by §2.
- `ThoughtProcessDialog` (the doorway from the thinking bubble) renders
  thumbnails in each tool block; `ToolExecutionLog` on the agent page (the
  home) renders them too; a click opens the full image.
- Fixture e2e `admin/e2e/tool-screenshots/` pins both surfaces with
  screenshots.

## 5. Documents

- [file-storage.md](../../standards/file-storage.md): executor-command
  attachments are `FileService` files linked by `executorCommandId`; tool
  images enter prompts only through `message-attachments.ts`.
- [executor-local-mcp.md](../../standards/executor-local-mcp.md): image
  extraction, caps, sidecars, the terminal-refusal rule.
- `docs/executor-protocol/`: the `attachment` signed domain.

## 6. Tests

- Daemon: extraction, dedupe of Kelpie's three copies (fixture built from the
  real result shape), caps and magic bytes, sidecar-before-journal ordering,
  crash between upload and receipt (re-upload is idempotent), terminal refusal
  rewrites the reference.
- API (real DB): upload in each allowed state, refused states, digest and
  magic mismatch, caps, accounting row written, result intake ref check,
  access arm with and without disclosure.
- Worker: refs to images through the loader, the combined cap, vision and
  non-vision connectors, retention placeholders, checkpoint round trip, the
  400 fallback.
- Live: Kelpie screenshot of a real site through the executor, described by
  the production model. **Not run in this PR.** It is step 7 of the live
  acceptance run after all PRs merge ([verification.md](verification.md)).
  Until then the chain is covered only in parts: the connector's
  `supportsVision` for `openai-compatible` in code, the images turn as a
  user-turn image part after the tool messages in the worker's suites, and
  the production model reading a PNG on a user message through
  Ledger/OpenRouter, checked directly on 2026-09-22 — never all of them
  together, with a real executor and a real Kelpie.
