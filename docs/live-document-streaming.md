# Live document streaming

The mechanics behind `CLAUDE.md` → "Live document streaming". The
invariants themselves are in `AGENTS.md`, and the spec is
[plans/2026-08-13-live-document-streaming/overview.md](plans/2026-08-13-live-document-streaming/overview.md).
Split out of `CLAUDE.md` when that file passed its structure-lint cap; no
content changed in the move.

## Live document streaming — watch a document being written

`kb_document_compose` writes a markdown document as its own `markdown` tool
argument and saves it as a real **`.md` file node** (`KnowledgePage.kind =
file` + an `Attachment` through the one `FileService` chokepoint); the person
watches the tokens arrive in a centered popup that renders markdown
progressively. Core invariants (two lanes, synchronous recorder, session
identity `(runId, invocationId, toolCallId)`, partial-JSON scanner, byte-match
save, interruption saves nothing, edits are deltas with independent
preview/save implementations): `AGENTS.md` → "Live document streaming". Spec:
[docs/plans/2026-08-13-live-document-streaming/overview.md](docs/plans/2026-08-13-live-document-streaming/overview.md).

Mechanics beyond those invariants:

- The document recorder receives the same live
  `() => runReplyIsRestricted(context)` predicate as the thinking recorder.
  It consults that monotone predicate per fragment: once a privileged source
  closes the thread-wide lane, `stream.document.delta` and
  `stream.document.edit` stay suppressed, metadata names are withheld, and
  structural/terminal frames carry `restricted: true` without document
  content. Durable chunks still contain the complete document so the
  streamed-vs-parsed byte assertion and save path remain independent; the
  current `RunBasisScope` is persisted before a restricted session or fragment
  becomes bootstrap-readable (the final reply is too late for a mid-stream
  reconnect). The barrier remembers exact scope keys and re-stamps whenever
  the monotone run basis widens; it does no database work for the common
  unrestricted fragment. The document-stream list, detail **and retarget**
  routes apply `RunBasisScope` through the shared run-disclosure reader before
  returning names/content or accepting a target mutation, with an unreadable
  session shaped exactly like an absent one. A client receiving a structural
  `restricted: true` frame treats it as the thread-wide broadcast it is and
  resolves the session through the viewer-authorized detail route. An entitled
  viewer receives the complete durable document; an unentitled viewer gets the
  route's indistinguishable 404 and the client removes the session, so no empty
  popup survives. The broadcast flag alone is never retained as a local denial
  across reconnects.

- The OpenAI-compatible connector enriches each `tool_call.delta` fragment with
  the call's accumulated `id`/`toolName`/`index` (`openai-chat-protocol.ts`) —
  never from the current chunk, because the canonical first chunk announces the
  name with empty arguments and yields no event. The same change removed a
  `continue` that silently dropped tool fragments from chunks that also carried
  content, corrupting the executed call. **Only OpenAI-compatible connectors
  stream tool arguments**; Kimi is `prompt-translated` and degrades
  honestly — the popup waits and the document appears complete when it
  arrives, never a fake typewriter.
- Lanes (`document-stream-lanes.ts`): **live** = `publishSseEphemeral`
  (`pg_notify` only — `stream.delta`'s per-token durable INSERT is the known
  write-amplification mistake); **durable** = coalesced 2 KiB/250 ms into
  `run_document_chunks` for reconnect/late-join bootstrap. `seq` is assigned at
  publish time, after any merge or NOTIFY-size split, so neither can fabricate
  a gap. The thread SSE route sets `X-Accel-Buffering: no` and
  `socket.setNoDelay(true)` (this fixes the existing `stream.delta` path too).
- `executeStage` brackets each inference attempt with `onInferenceAttempt` →
  `beginInvocation`, marking any still-open session `superseded`; the executing
  handler finds *its* session by `toolCallId` and awaits `settle()` before
  saving.
- `createPartialJsonScanner` (`packages/schemas/src/partial-json.ts`) enforces
  **committed-prefix monotonicity** (half-arrived escapes, `\uXXXX` fragments,
  and lone surrogates are withheld — a chunk boundary splits a literal emoji
  just as easily) and **duplicate-key rejection** (`JSON.parse` keeps the
  *last* duplicate, so a second top-level `markdown` key could make the saved
  file differ from the streamed one). The save asserts streamed-equals-parsed
  byte-for-byte and refuses on mismatch.
- **Stop discards.** Cancellation aborts the provider request through a typed
  `InferenceAbortedError` converted in `executeStage` where the signal is still
  in scope (lower layers re-wrap the error so only its message survives, and
  `callInferenceWithRetry` would otherwise *re-run the whole generation*).
  `document-cancel-poll.ts` watches `cancelRequestedAt` on its own timer only
  while a session is open, so ordinary runs pay nothing. The save claims its
  session with a conditional `streaming → saving` update, so cancel and save
  always have one winner.
- A document landing in a **private space is created published** — the person
  who asked for it is its only reader and just watched it being written; shared
  spaces keep the `kb_publish_request` review gate.
- Edits (`kb_document_edit`): the recorder loads the base document through the
  same reader the save uses (`knowledge-document-io.ts` `readMarkdownDocument`)
  which resolves the source space through the shared `scopeForVisibility` path
  and feeds `consumedSources` before it opens the attachment. The recorder then
  seeds the base through the same restriction barrier as every durable append,
  *before* `stream.document.start`, so a private edit is restricted from its
  first frame and an entitled bootstrap sees the document rather than an empty
  page. The durable lane switches to **snapshot** mode for edits (mid-document
  changes cannot be a log of appends; bootstrap concatenates chunks in id order).
  `stream.document.edit {editIndex, offset, removeLength}` precedes the
  replacement deltas; `stream.document.delta.offset` is the absolute insertion
  point (composing a new document is the degenerate case: one edit at offset 0
  removing nothing), and the client applies deltas in `seq` order — offsets are
  not monotonic, so offset-based dedup would be wrong.
- SSE events: `stream.document.start` / `.meta` / `.delta` / `.done` / `.error`
  / `.target` / `.edit`. Only `.delta` joins the hub's no-replay list — that
  list *withholds* events from `Last-Event-ID` reconnects, so terminators must
  replay. Ephemeral events write no `id:` line, never touch
  `connection.lastSequence`, and are dropped (not buffered) during
  connect-hydration; a saturated connection drops them and the resulting `seq`
  gap makes the client re-bootstrap. REST:
  `GET /api/threads/:id/document-streams[?active=1]`,
  `GET …/document-streams/:sessionId` (offset watermark in UTF-16 code units),
  `POST …/document-streams/:sessionId/target` for the popup's address bar.
  Every per-session route re-checks `session.threadId` **and**
  `organizationId` — `sessionId` is a global UUID and the thread gate alone
  would leak other orgs' documents.

