# Live document streaming — PA writes a document while you watch the tokens arrive

**Status:** design for review (codex/sol, kimix, fable verify → Opus builds). No code
has been written.

## 1. Goal

A user asks their personal assistant (PA) to create a document. In conversation
they agree on a location for it. When the assistant starts writing, a centered
popup opens over the conversation and renders the document as **formatted
markdown, progressively, token-by-token, as the model actually emits them**.
When generation finishes, the document is saved as a Knowledge Base draft at the
agreed location and the popup offers to open it.

Hard requirements, restated as invariants this design must satisfy:

1. **Genuine real-time.** Tokens render as they arrive from the provider stream.
   No buffer-then-replay, no fake typewriter over a completed string, no
   timer-driven trickle. Every hop between provider chunk and browser paint must
   be per-chunk push; any coalescing permitted only at or below one display
   frame on the client.
2. **Progressive formatted markdown.** The popup renders headings, emphasis,
   lists, tables, code blocks — not raw source — and stays visually stable while
   the tail of the document is syntactically incomplete.
3. **Agreed target location.** The finished document lands where the user and PA
   agreed, durably, with a link from the popup and the chat.

## 2. What exists today (survey)

### 2.1 Token streaming, end to end

The pipeline is already genuinely streaming for reply text and reasoning:

```
Provider HTTP SSE (stream:true)
  → collectChatStream()                    packages/runtime/src/inference/connectors/openai-chat-protocol.ts:150
      yields per parsed chunk, same tick:
        { type: 'reasoning_text.delta', text }     ← delta.reasoning_content
        { type: 'output_text.delta',    text }     ← delta.content
        { type: 'tool_call.delta',      text }     ← delta.tool_calls[].function.arguments  (!)
  → connector.stream()                     openai.ts / minimax.ts (both reuse collectChatStream)
  → InferenceService.stream()              packages/runtime/src/inference/service.ts:120
  → executeStage() drain loop              worker/src/run/inference-stage.ts:232-246
      reasoning_text.delta → onVisibleReasoningDelta → ThinkingRecorder (coalesced 2 KiB / 250 ms)
      output_text.delta    → onVisibleTextDelta      → publishSse 'stream.delta' (per chunk, uncoalesced)
      tool_call.delta      → **silently dropped**
  → PgRealtimeTransport.publishSse         packages/runtime/src/realtime.ts:227
      INSERT thread_stream_events RETURNING id  +  SELECT pg_notify('nessie_realtime', json)
  → API realtime hub LISTEN                api/src/realtime/hub.ts
  → GET /api/threads/:threadId/stream      api/src/routes/threads.ts:359 (hijacked SSE, Bearer-gated
                                           by findThreadForUser, Last-Event-ID resume, 15 s keepalive)
  → admin useThreadStream                  admin/src/facades/threads/hooks.ts:116
      fetch + readSseStream (not EventSource; needs the Bearer header)
      stream.delta → string-concat into pendingMessages[].content (React state)
  → ChannelMessageFeed → StreamingMessageRow renders accumulated text via MessageMarkdown
```

Facts that shape this design:

- **`tool_call.delta` already exists and is dropped.** The OpenAI-compatible and
  MiniMax connectors yield one event per `function.arguments` fragment
  (`openai-chat-protocol.ts:242-248`). The event type is in the union
  (`packages/runtime/src/inference/types.ts:163`) and both Zod mirrors
  (`packages/schemas/src/inference-core.ts:266`,
  `api/src/contracts/inference-core.ts:294`). The worker's drain loop
  (`inference-stage.ts:232-246`) handles only reasoning and output text; the
  tool fragments fall through unread. Today the payload carries only `text` —
  no tool-call `index`/`id`/`name` — so fragments are uncorrelatable until
  enriched.
- **Kimi does not stream tool args.** `connectors/kimi.ts` uses
  `toolCallingMode: 'prompt-translated'`: the tool call streams as
  `output_text.delta` XML and is parsed only after the stream ends. The
  no-`stream` connector fallback (`service.ts:120-127`) emits the whole answer
  as one synthetic delta. Production chat (Ledger DeepSeek adapter,
  openai-compatible protocol) **does** stream tool args.
- **`stream.delta` is published per provider chunk with no coalescing**
  (`worker/src/run/execute/run-inference.ts:95-102`) — but each publish is a
  durable `INSERT` into `thread_stream_events` plus a `pg_notify`, `await`ed
  inside the provider read loop. That is the existing latency floor
  (~2 DB round-trips per chunk, serialized against reading the next chunk).
  Reasoning deliberately coalesces (2 KiB / 250 ms,
  `worker/src/run/execute/thinking-recorder.ts`) to avoid exactly this.
- **`stream.*` events are excluded from SSE backlog replay**
  (`api/src/realtime/hub.ts:229-236`); mid-run joiners bootstrap over REST
  (`GET /api/threads/:id/thinking`). A reconnecting client currently loses
  in-flight `stream.delta` text entirely (no durable counterpart) — a defect
  this feature must not replicate.
- **The thread SSE route lacks `X-Accel-Buffering: no` and
  `socket.setNoDelay(true)`.** The Agent Designer's bespoke SSE route sets both
  (`api/src/services/designer.ts:311-314`); `api/src/routes/threads.ts:378-388`
  sets neither. Nagle adds up to ~40 ms per small write and a fronting proxy
  may buffer the stream — both violate requirement 1 and must be fixed.
- **`pg_notify` payloads are capped at 8000 bytes.** Nothing guards this today;
  a document delta pipeline must split oversized fragments defensively.
- **The Agent Designer already built a bespoke version of this feature.**
  `api/src/services/designer.ts:200-290` emits
  `tool_call.start {id,name}` → `tool_call.delta {id,args}` →
  `tool_call.done` over its own SSE; the client
  (`admin/src/facades/designer/hooks.ts:288-340`) keeps a per-call args buffer
  and runs `extractPartialContent` — a partial-JSON extractor that pulls a
  growing string field out of half-written JSON and appends only the new
  suffix. That extractor is the proven core we lift, but the designer path
  bypasses the worker run pipeline entirely, so it is precedent, not
  infrastructure.

### 2.2 Where documents live

- **Model:** `KnowledgeSpace` → `KnowledgePage` tree (`parentPageId` +
  `position`; `kind: document | file`; folders are virtual — a page with
  children or `metadata.folder = true`) → append-only `KnowledgePageVersion`.
  **`KnowledgePageVersion.body` is HTML, not markdown** (rendered read-only
  through TipTap `RichTextContent.tsx`). Markdown *uploads* are converted to
  HTML documents via `api/src/lib/markdown.ts` (`markdown-it`, `html: false`) —
  API-side only; the worker has no markdown dependency today.
- **Agent tools:** `kb_search`, `kb_page_read`, `kb_list` (spaces / page-tree
  outline), `kb_draft_write` (create/update a draft page: `spaceId?`, `pageId?`,
  `title?`, `body` (HTML), `summary?`, `labels?`, `parentPageId?`, `taskId?`,
  `changeComment?`), `kb_file` (move/rename own drafts), `kb_publish_request`
  (opens an `ApprovalRequest`). None are PA-only; the real gates are inside the
  handler (`worker/src/run/pa-tools/knowledge-write.ts`): access via
  `buildSpaceViewerPrincipal` (a delegating PA uses the **owner's** access
  identity), `canWriteSpace`, hard deny on `sensitivityTier = restricted`,
  agent-authored pages always `status = draft` with `authorType = agent`,
  publication human-gated.
- **Locations are UUID tuples** `(spaceId, parentPageId, position)` — no slugs,
  no paths. Conversational anchors that exist: space names via `kb_list()`,
  per-space outline via `kb_list({spaceId})`, well-known provisioned spaces
  ("My Docs" per user, "Project Documents" per project), `taskId` binding, and
  exact-title resolution (`resolveTitleToPageId`,
  `packages/knowledge/src/native-links.ts:70`).

### 2.3 Admin UI and mobile

- **One markdown renderer:**
  `admin/src/components/features/channels/MessageMarkdown.tsx` —
  `react-markdown` + `remark-gfm`, no `rehype-raw` (raw HTML never becomes
  elements — keep it that way), input normalized by
  `normalizeMessageMarkdown` (`admin/src/lib/message-markdown.ts`), which
  already **leaves a legitimately unclosed fence open** — exactly the right
  behaviour mid-stream. Styling under `.admin-message-markdown`
  (`styles.css:1264-1424`), tokens only.
- **Dialog pattern:** no portals, no dialog library. Canonical markup =
  `fixed inset-0 z-[100] flex items-center justify-center bg-[var(--scrim-strong)] backdrop-blur-sm`
  outer + `role="dialog" aria-modal tabIndex={-1}` panel +
  `useModalA11y` (focus trap, Escape with `stopPropagation`). Ownership
  pattern: a `useXxxDialog()` hook returns `{ open, dialog }` and the owning
  feed renders `{dialog}` — how `ThoughtProcessDialog` serves both the channel
  feed and the reply panel. Responsive split (desktop centered / phone
  fullscreen sheet with `100dvh` + safe-area padding):
  `ChannelConversationComposePage.tsx:220-240`.
- **Scroll pinning:** `admin/src/hooks/useStickToBottom.ts` (ResizeObserver
  based — correct for reflowing markdown), not ThoughtProcessDialog's
  length-keyed `useLayoutEffect`.
- **State architecture:** facades (`admin/src/facades/<domain>/`) own React
  Query hooks + pure React-free helpers with node tests. Division of labour:
  WebSocket → cache invalidation; SSE → live deltas in component state;
  REST → durable record.
- **Mobile is the same SPA** in an Expo/React-Native `react-native-webview`
  shell (`mobile/`), loading `app.nessie.works`. `fetch` + `ReadableStream`
  SSE works in WKWebView/Android WebView. Constraints: `fixed inset-0` covers
  only the WebView frame (native tab bar sits outside); pad with
  `env(safe-area-inset-*)`; use `100dvh`; background suspension drops the SSE
  connection, so recovery must come from the reconnect loop
  (`admin/src/facades/threads/stream-retry.ts`) plus a REST bootstrap, never
  from assuming an unbroken stream.

## 3. The central decision: where do the document's tokens come from?

Three candidate architectures were considered.

### Option A — stream the tool-call arguments (CHOSEN)

The model writes the document **as the `markdown` argument of a new tool call**
in its ordinary main turn. The worker taps the already-produced
`tool_call.delta` fragments, incrementally extracts the `markdown` string field
out of the half-written JSON server-side, and publishes decoded markdown deltas
to the thread's SSE stream. When the turn completes, the tool executes normally
and saves the document.

- ✅ One inference. The document is in the model's own context as the tool call
  it made — follow-up requests ("tighten section 2") work naturally with the
  existing `kb_page_read`/`kb_draft_write` loop, and nothing is paid twice.
- ✅ The extraction problem is already solved once in this codebase
  (`extractPartialContent`, designer facade) — we move it server-side and share
  it.
- ✅ Producer-side: zero new inference machinery; the tap is a ~10-line addition
  to the existing drain loop plus payload enrichment.
- ⚠️ Provider coverage: OpenAI-compatible (incl. Ledger production) and MiniMax
  stream tool args; Kimi (prompt-translated) and the non-streaming fallback do
  not. Degrade (§4.8) is *honest*: the popup shows a "writing…" state and the
  document appears when it exists. **Never a fake typewriter.**
- ⚠️ JSON escape decoding must be incremental and split-safe (`\n`, `\"`,
  `\uXXXX` can straddle chunk boundaries). Bounded, testable problem (§4.3).

### Option B — dedicated sub-inference inside the tool (rejected)

`document_compose` triggers a second streaming inference whose plain text output
*is* the document; `output_text.delta` handling is reused unchanged.

- ✅ Clean markdown deltas on every connector that streams text (incl. Kimi).
- ❌ The main model never saw the document it "wrote" — the full body must be
  returned as a tool result to keep follow-up edits possible, so every document
  is paid for twice (generation + context re-entry), and long documents hit the
  32 k tool-result truncation chokepoint.
- ❌ New machinery: a second inference path inside a tool handler, its own
  budget/cancel/timing integration, prompt construction for "now write it".
- ❌ The 30 s default tool timeout (`budget.toolTimeoutMs`) is hostile to a
  multi-minute generation living *inside* a tool call.

### Option C — write the document as the visible reply, then save it (rejected)

Reuses `stream.delta` untouched, but hijacks reply routing, dumps the whole
document into the chat transcript, and depends on a fragile "your next message
is the document" protocol. Violates the popup/chat separation the feature is
about.

**Decision: Option A**, with Option B's degrade behaviour (atomic appearance)
as the honest fallback for non-arg-streaming providers.

## 4. End-to-end design

### 4.1 The tool: `kb_document_compose`

New builtin, defined beside the other KB tools in
`packages/runtime/src/builtin-kb-tools.ts`, implemented in
`worker/src/run/pa-tools/` next to `knowledge-write.ts`.

```jsonc
{
  "name": "kb_document_compose",
  "personalAssistantOnly": true,          // v1 scope — see §6 decision 3
  "description": "Write a full markdown document and save it as a Knowledge Base draft at an agreed location. The user watches the document stream in live, so write the final document directly — no preamble inside `markdown`.",
  "input": {
    // Location/identity fields FIRST, content LAST. Models overwhelmingly emit
    // arguments in schema order; the popup can therefore show the title and
    // target while the body is still streaming. Order is an optimization, not
    // a correctness dependency (§4.4).
    "spaceId":      "uuid (required)",
    "parentPageId": "uuid (optional)",
    "title":        "string (required)",
    "summary":      "string (optional)",
    "labels":       "string[] (optional, ≤16)",
    "taskId":       "uuid (optional)",
    "changeComment":"string (optional)",
    "markdown":     "string (required) — the complete document body in GitHub-flavored markdown"
  }
}
```

Execution (the tool handler, running *after* the turn's stream has completed and
the args parsed):

1. Re-run the exact `kb_draft_write` authorization: owner-principal space
   access (`buildSpaceViewerPrincipal` → `canWriteSpace`), restricted-tier
   deny, 200 000-char body cap. Same service seam, not a copy — factor the
   shared core out of `runKbDraftWriteTool` rather than forking it
   (AGENTS.md "reuse, never fork").
2. Convert markdown → HTML with the **same converter the markdown upload path
   uses**. `api/src/lib/markdown.ts` (`markdown-it`, `html: false`) moves to a
   shared package (natural home: `packages/knowledge`, exported as
   `markdownToHtml`) and the api re-exports it — the worker must not grow a
   second, different markdown pipeline. `html: false` neutralizes raw tags
   before the existing `UNSAFE_BODY_PATTERN` guard even runs.
3. Create the page exactly as `kb_draft_write` does: `kind: document`,
   `status: draft`, `authorType: agent`, version 1, chunks + link index.
4. Finalize the stream session (§4.3): mark it `saved`, record `pageId` /
   `versionNumber`, publish `stream.document.done`.
5. Return to the model: `pageId`, `title`, resolved location (space name +
   parent title), version number, and character count — **not** the body (the
   model already has it verbatim in its own tool call).

The model keeps `kb_list` / `kb_search` for the location-agreement phase and
`kb_page_read` / `kb_draft_write` / `kb_file` / `kb_publish_request` for
follow-ups; `kb_document_compose` is only the "write it fresh, live" verb.
Prompt guidance for the PA (in the PA base prompt, model-judged as always —
no string matching anywhere): before calling it, confirm the destination with
the user and resolve names to ids via `kb_list`.

### 4.2 Worker: tapping the stream

**(a) Enrich `tool_call.delta`.** Add `index: number`, and when present
`id: string` / `toolName: string`, to the yielded event in
`openai-chat-protocol.ts` (the connector already tracks all three in its
accumulation map) and to the three type mirrors
(`runtime/src/inference/types.ts`, `packages/schemas/src/inference-core.ts`,
`api/src/contracts/inference-core.ts`). MiniMax inherits via the shared
protocol. Kimi remains without the event — by design.

**(b) New drain-loop branch.** `executeStage`
(`worker/src/run/inference-stage.ts`) gains
`onToolCallDelta?: (event: {index, id?, toolName?, text}) => void` beside the
two existing callbacks, threaded up through `runInferenceGraph`
(`worker/src/run/inference.ts`) to `createRunInference`
(`worker/src/run/execute/run-inference.ts`) exactly like
`onVisibleTextDelta`. Note the signature is **synchronous fire-and-forget**
(`void`, not `Promise`): the document pipeline must never add backpressure to
the provider read loop (see (d)).

**(c) The `DocumentStreamRecorder`**
(`worker/src/run/execute/document-stream.ts`, sibling and structural mirror of
`thinking-recorder.ts`). Created per run in `run-job.ts` beside the
ThinkingRecorder; `close()` fused into the same `finally`. It consumes enriched
tool-call deltas and:

1. **Detects the target call.** Maintains per-`index` accumulated raw args.
   The first fragments carry `toolName`; only `kb_document_compose` calls get a
   session — everything else is ignored at zero cost. (`authorizeToolCall`
   still runs at execution time as today; the recorder is presentation, not
   authorization.)
2. **Opens a session on detection.** Insert a `run_document_sessions` row
   (`status: streaming`) and publish `stream.document.start` immediately —
   before the location args have finished streaming — so the popup opens at
   the earliest honest moment. As `spaceId`/`parentPageId`/`title` become
   parseable from the partial JSON, publish a single
   `stream.document.meta` with the resolved names (one cheap lookup).
3. **Extracts markdown incrementally.** A shared, React-free
   `extractPartialStringField(buffer, key)` utility (new module in
   `@nessie/runtime` or `packages/schemas`; port of the designer facade's
   `extractPartialContent`, hardened for: escapes split across chunks,
   `\uXXXX` halves, the key appearing inside earlier string *values*, and
   absent-key buffers). It returns the decoded value-so-far; the recorder
   diffs against the last emitted length and gets the new decoded suffix.
   The admin's designer facade migrates to the shared util (one
   implementation, two callers).
4. **Publishes live deltas ephemerally, per provider chunk.** New transport
   method `PgRealtimeTransport.publishSseEphemeral(threadId, event, data)`:
   `pg_notify` only — **no `thread_stream_events` insert** — reusing the
   existing notification envelope with a `durable: false` marker so the hub
   forwards it identically but assigns no replayable sequence (these events
   set no SSE `id:` field, so they can never corrupt `Last-Event-ID` resume).
   Rationale: `stream.delta`'s per-token durable INSERT is the known
   write-amplification/latency mistake; replay is covered by the bootstrap
   endpoint instead (§4.5). Each event:
   `stream.document.delta { runId, sessionId, seq, offset, content }` where
   `offset` is the decoded-markdown byte offset before this fragment and `seq`
   a per-session counter — the client can detect gaps/overlaps exactly.
   Fragments over 4 KiB are split (pg_notify 8 KB cap, JSON envelope
   overhead). Publishes are serialized on a per-session promise queue (the
   ThinkingRecorder pattern) so ordering holds **without** the drain loop
   awaiting them; errors are swallowed with a `console.warn` (streaming
   display is never worth failing a run).
5. **Persists durable chunks, coalesced.** In the same queue, append decoded
   markdown to `run_document_chunks` batched at 2 KiB / 250 ms (ThinkingRecorder
   constants). This is the mid-stream-join/reconnect source of truth. The live
   path and the durable path are deliberately different cadences: live = every
   chunk, durable = coalesced. Requirement 1 constrains the live path only.
6. **Finalizes.** The tool handler (§4.1) or the failure paths (§4.7) close the
   session: `status ∈ saved | failed | cancelled | superseded`, then
   `stream.document.done` / `stream.document.error`. `stream.done` (the run
   terminator) remains published last, unchanged.

**(d) No backpressure, no reordering.** The drain loop calls the recorder
synchronously; the recorder enqueues onto its internal promise chain and
returns. The provider read loop is never blocked by Postgres. This is a
deliberate divergence from `stream.delta`'s awaited publish — and is what makes
per-chunk publishing affordable.

**(e) Multiple/parallel calls.** If a turn contains two `kb_document_compose`
calls (unusual but legal), each `index` gets its own session; the popup shows
the most recent, with the older chip-ized (§4.4). If the model emits a second
compose call in a *later* iteration of the same run, the earlier session is
already terminal (`saved`) — sessions are per tool-call, not per run.

### 4.3 Transport additions

New SSE events in `packages/schemas/src/realtime-sse.ts` (enum + discriminated
union + `SseEventMap`):

```ts
'stream.document.start': { runId, sessionId, threadId, agentId, toolCallIndex }
'stream.document.meta':  { runId, sessionId, title?, spaceId?, spaceName?,
                           parentPageId?, parentTitle? }        // once, when parseable
'stream.document.delta': { runId, sessionId, seq, offset, content }
'stream.document.done':  { runId, sessionId, pageId, versionNumber, title,
                           spaceId, spaceName, chars }
'stream.document.error': { runId, sessionId, reason:
                           'cancelled' | 'run_failed' | 'save_failed' |
                           'budget_stopped' | 'invalid_args',
                           partialSaved: boolean, pageId? }
```

- All five are added to the hub's no-replay list (`api/src/realtime/hub.ts`).
  `delta` is never durable at all; `start/meta/done/error` are published
  durably (ordinary `publishSse`) so a *reconnecting* client (`Last-Event-ID`)
  still learns a session ended — cheap (≤4 rows per document) and consistent
  with `stream.done` replay semantics. Fresh connects rely on bootstrap.
- **SSE route hardening** (`api/src/routes/threads.ts`): add
  `X-Accel-Buffering: no` and `socket.setNoDelay(true)`, matching
  `designer.ts:311-314`. This benefits the existing `stream.delta` path too and
  is required for requirement 1.

New REST endpoint (bootstrap / reconnect / late-join), beside the thinking
routes in `api/src/routes/threads.ts`, same `findThreadForUser` gate:

```
GET /api/threads/:threadId/document-streams?active=1
  → [{ sessionId, runId, agentId, status, title?, target?, startedAt }]
GET /api/threads/:threadId/document-streams/:sessionId
  → { session: {…as above, pageId?, versionNumber?}, markdown, offset }
       // markdown = concatenated run_document_chunks; offset = its byte length
```

Client contract: bootstrap gives `{markdown, offset}`; live deltas carry
`offset`; the client drops any delta whose `offset + content.length ≤` what it
already has, applies the tail of one that straddles, and on a `seq` gap
re-bootstraps. Durable chunks trail the live stream by ≤250 ms, so a
reconnecting client may re-fetch a bootstrap marginally behind the notify
stream it then joins — the offset arithmetic makes the merge exact.

### 4.4 The popup (admin)

**Facade** — `admin/src/facades/threads/document-stream.ts` (+ pure helpers in
`document-stream-helpers.ts`, node-tested like `thinking.ts`):

- The existing `useThreadStream` SSE connection is the single subscription; its
  frame handler gains the five `stream.document.*` cases and exposes
  `documentSessions: DocumentStreamEntry[]` beside `pendingMessages`. **No
  second SSE connection.**
- `DocumentStreamEntry = { sessionId, runId, status, title?, target?,
  markdown, offset, lastSeq, startedAt, result? }`. Deltas append via the
  offset contract above. On mount / reconnect / `visibilitychange`-resume, a
  React Query bootstrap (`['threads', threadId, 'documentStreams']`) seeds or
  repairs entries; `reconcile` mirrors `reconcileThreadThinking`'s
  zombie-guard (a session whose run is no longer `pending|running` and that
  has no `done`/`error` event resolves via one session GET, and shows
  `failed` if the session never finalized).

**Dialog** — `admin/src/components/features/channels/DocumentStreamDialog.tsx`,
owned via `useDocumentStreamDialog()` returning `{ dialog, openSession }`,
rendered by `ChannelMessageFeed` (the ThoughtProcessDialog seam — channel feed
and reply panel share it for free):

- **Open:** auto-opens when a `stream.document.start` arrives for the surface
  the viewer has mounted (PA DM = the viewer is the owner by construction).
  Reopenable from a compact chip (below). Deep-linking is not needed in v1 —
  the dialog is conversation-local state, like the thought dialog.
- **Chrome:** canonical centered dialog (scrim + `useModalA11y`), desktop
  `max-w-3xl max-h-[calc(100dvh-3rem)]`; `usePhoneLayout()` switches to the
  fullscreen-sheet variant (`100dvh`, safe-area padding, backdrop click
  disabled) per `ChannelConversationComposePage`. Header: doc title (or
  "Writing document…" until `meta`), target path chip
  (`spaceName / parentTitle`), a live character counter, and the streaming
  dots. Footer while streaming: **Hide** (minimize) and **Stop** (§4.7);
  after `done`: **Open document** (navigates
  `/knowledge-base?spaceId=…&pageId=…` — the existing
  `useKnowledgePageDeepLink` contract) and **Close**.
- **Minimize ≠ cancel.** Escape / scrim click / Hide collapse the dialog to a
  small pill in the feed footer area
  (`DocumentStreamChip.tsx` — title + progress dots, sibling of the thinking
  bubble), with generation untouched server-side. Only the explicit Stop
  button cancels. The chip also covers: user navigates away and back (facade
  state is per-thread-mount, so returning re-bootstraps), and second/parallel
  sessions.
- **Ties to the turn:** entries key on `sessionId` and carry `runId`; the
  thinking bubble for the same run keeps working unchanged (reasoning before
  the tool call streams into the bubble; the moment the compose call starts,
  document tokens go to the popup — two surfaces, one run, no double-painting
  of the same bytes).

**Progressive markdown rendering** —
`admin/src/components/features/channels/StreamingMarkdown.tsx`:

1. **Buffer → frame throttle.** Deltas land in facade state as they arrive;
   the component re-renders through a `requestAnimationFrame` gate (a delta
   arriving mid-frame marks dirty; paint happens next frame). This is at-most
   one frame (~16 ms) behind arrival — display-refresh cadence, not
   buffering, and the character counter in the header binds directly to state
   so arrival is observable even between paints.
2. **Block-freeze parsing.** The accumulated markdown splits into blocks at
   top-level blank lines **outside fenced code** (a ~30-line pure splitter in
   `document-stream-helpers.ts`, fence-aware, node-tested). All blocks except
   the final one are *stable*: rendered once through
   `<MessageMarkdown renderInlineText={identity}>` and memoized
   (`React.memo` on `(blockText)`). Only the live tail block re-parses per
   frame. Cost per frame is O(tail), not O(document) — a 100-page document
   streams as cheaply as a paragraph.
3. **Tail repair, not tail hiding.** Before parsing, the tail block passes
   through `repairStreamingTail()`: append a closing ``` for an odd fence
   count (so a streaming code block renders *as a code block* immediately —
   `normalizeMessageMarkdown` already deliberately keeps legitimate open
   fences); close an unbalanced trailing `**` / `*` / `` ` `` pair-wise;
   leave half-written links/images (`[text](htt`) as literal text (they render
   as text until complete — acceptable flicker-free behaviour). The repair is
   applied to the *rendered copy only*; state always holds the exact received
   bytes. GFM tables render progressively as soon as header + delimiter rows
   exist (remark-gfm native behaviour); no repair needed.
4. **Scroll pinning** via `useStickToBottom` (ResizeObserver — correct under
   markdown reflow); user scroll-up releases the pin, a "Jump to latest"
   affordance re-pins.
5. **Theming:** reuses `.admin-message-markdown` styles wholesale; dialog
   surface tokens `--panel` / `--sep` / `--scrim-strong`; rem-based type
   (FontScaleProvider); code blocks keep their own `overflow-x: auto`
   (zoom is disabled in the shells).

### 4.5 Agreeing the location, and saving

The agreement phase is **conversation, not UI** (v1): the PA already has
`kb_list` to enumerate spaces and walk a space's outline, well-known anchors
("My Docs", "Project Documents", ticket folders), and title→id resolution.
The PA proposes ("I'll put it in *Project Documents › Meetings*, under the
2026 folder — ok?"), the user confirms in their own words, the model judges
the confirmation (never string-matched — AGENTS.md), and only then calls
`kb_document_compose` with resolved UUIDs. The popup's target chip (from
`stream.document.meta`) is the visible receipt of that agreement; if it shows
the wrong place, Stop is one click and nothing was published.

Save semantics (decisions, flagged in §6):

- The page is created **once, at tool execution** — not progressively. A
  half-generated draft page would churn versions/chunks/embeddings per flush
  for no user value; the durable stream lives in `run_document_chunks` until
  the save.
- Saved as **`status: draft`, agent-authored**, exactly like `kb_draft_write`;
  the PA then *offers* `kb_publish_request` in chat (Librarian precedent).
  The existing publish approval gate is untouched.
- The original markdown source is stored on the page as
  `metadata.markdownSource = { sessionId, runId }`? **No** — v1 stores HTML
  only, matching the markdown-upload precedent; the markdown is recoverable
  from the session chunks until pruned. Revisit if two-way md editing ever
  ships (§6 Q5).
- Missing intermediate folders are **not** auto-created (`kb_draft_write`
  cannot create folders today); the PA must target an existing parent or the
  space root. Widening folder creation is out of scope.

### 4.6 The genuine-real-time guarantee, stated as an audit list

Every hop, with its worst-case added latency; anything not listed is
event-driven push:

| Hop | Mechanism | Added latency |
|---|---|---|
| Provider → worker | HTTP SSE chunk, parsed and yielded same tick | network only |
| Drain loop → recorder | synchronous call | ~0 |
| Recorder → Postgres NOTIFY | per provider chunk, serialized queue, **no timers, no size thresholds, no durable insert** on the live path | one `pg_notify` round-trip |
| NOTIFY → API hub | `LISTEN` push | ~0 |
| Hub → browser | `res.write` on hijacked socket, `setNoDelay`, `X-Accel-Buffering: no` | network only |
| Browser → state | SSE frame parse → facade state, same tick | ~0 |
| State → paint | `requestAnimationFrame` gate | ≤ 1 display frame |

Explicitly **absent**: any accumulate-and-replay, any fixed-rate typewriter,
any client-side timer that meters out text. The only smoothing in the whole
pipeline is the display-frame gate.

Honest degrades (never faked):

- **Kimi / prompt-translated tool calling:** no `tool_call.delta` exists. The
  session opens at tool *execution* time instead (recorder hook in
  `onToolCallStart`), the popup shows an indeterminate "writing…" state, and
  the document renders in full when the tool runs. It appears at once because
  it *arrived* at once.
- **Non-streaming connector fallback:** same behaviour, same reason.
- **SSE disconnect (incl. WebView background suspension):** reconnect loop +
  offset bootstrap; the document catches up in one jump to wherever generation
  actually is — a true fast-forward, not a replay animation.

### 4.7 Errors and cancellation

| Scenario | Behaviour |
|---|---|
| **User clicks Stop** | Dialog calls existing `POST /api/runs/:id/cancel` (confirm-in-dialog first). Cooperative cancel today only polls between iterations/tool batches — during argument streaming nothing would notice. **Addition:** the drain loop, when a document session is active, checks `cancelRequestedAt` (piggybacking `checkCancelled`, throttled to ≥1 s) and aborts the provider request via the connector's fetch `AbortController`; the run then exits through the existing `cancel-stop.ts` machinery. Session → `cancelled`, `stream.document.error {reason:'cancelled', partialSaved}`. Partial body **saved as an interrupted draft** (change comment "Interrupted — cancelled by user", title suffix "(incomplete)") — recommended default, see §6 Q2. |
| **Run fails / crashes mid-stream** | `failure.ts` path already publishes `stream.done`; the recorder's `close()` (fused in `run-job.ts` `finally`, like ThinkingRecorder) marks any non-terminal session `failed` and publishes `stream.document.error {reason:'run_failed', partialSaved}` first. Worker hard-crash: sessions are re-terminalized when the queue re-delivers the run to a terminal state (the working-marker precedent); the client's zombie-guard (§4.4) covers the gap meanwhile. |
| **Budget stop / wind-down** | `budget-stop.ts` aborts like a failure for the in-flight turn: session `failed`, `reason:'budget_stopped'`, partial saved per the same policy. The wind-down injection (80 %) happens between turns, so a compose call that already started streaming is never truncated by wind-down itself. |
| **Args invalid at execution** (bad `spaceId`, access denied, body cap) | The stream looked fine but the save is refused: session `failed`, `reason:'save_failed'` (or `invalid_args`), `partialSaved:false`; the tool returns the error to the model, which apologizes / retries with a corrected location in the same run — a brand-new session, popup follows the newest. Dialog shows the error with the streamed content still visible (copyable), so nothing the user watched is lost. |
| **SSE payload oversize / notify failure** | Fragments >4 KiB split; publish errors are swallowed (warn) — the durable chunk path and bootstrap self-heal the client via the `seq` gap → re-bootstrap rule. |
| **Two sessions at once** | Dialog binds to the newest `streaming` session; earlier ones chip-ize. |

### 4.8 Web vs. mobile (WebView shell)

One implementation — the dialog is admin SPA code and the mobile app loads the
same SPA. Mobile-specific handling, all already-established patterns:

- `usePhoneLayout()` → fullscreen sheet: `fixed inset-0 z-[90]
  bg-[color:var(--main)]`, `h-[100dvh]`,
  `pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]`,
  backdrop-dismiss off (Hide is an explicit button). The sheet covers the
  WebView frame; the native tab bar remains visible — acceptable for v1 (the
  compose page sets the same precedent). No `postMessage` shell choreography
  needed (the search-overlay mechanism exists if we later want native chrome
  to step aside).
- SSE over `fetch`+`ReadableStream` works in WKWebView / Android WebView; the
  stream dies on background suspension and on the shell's blank-boot
  remount/reload recovery — both recovered by `runStreamConnectionLoop`
  backoff + the offset bootstrap on reconnect and on `visibilitychange`.
- No pinch zoom in the shells → the markdown container inherits
  `.admin-message-code-block`'s own horizontal scrolling (already re-asserted
  by the Android injected CSS).
- No native code changes in `mobile/` at all.

## 5. Data model, new surface, and change map

### 5.1 Prisma (one migration)

```prisma
model RunDocumentSession {          // run_document_sessions
  id             String   @id @default(uuid()) @db.Uuid
  runId          String   @db.Uuid          // + relation, index
  threadId       String   @db.Uuid          // index (bootstrap query)
  agentId        String   @db.Uuid
  organizationId String   @db.Uuid          // tenancy, matches run
  toolCallIndex  Int
  status         RunDocumentSessionStatus   // streaming|saved|failed|cancelled|superseded
  title          String?
  spaceId        String?  @db.Uuid
  parentPageId   String?  @db.Uuid
  pageId         String?  @db.Uuid          // set on save
  versionNumber  Int?
  errorReason    String?
  chars          Int      @default(0)
  createdAt / updatedAt / finishedAt
}
model RunDocumentChunk {            // run_document_chunks — mirrors run_thinking_chunks
  id        BigInt  @id @default(autoincrement())
  sessionId String  @db.Uuid        // index (sessionId, id)
  offset    Int                     // decoded-markdown byte offset of this chunk
  content   String  @db.Text
  createdAt DateTime @default(now())
}
```

Retention: chunks are working data — a `document-stream.prune` sweep (worker
control loop, beside existing sweeps) deletes chunks for sessions terminal
for >7 days; sessions rows stay (cheap, and back the ops/debug story).
Index-creation lint rule: neither table is on the hot-table list, plain
indexes fine.

### 5.2 Change map (for the implementer)

| Area | Files | Change |
|---|---|---|
| Provider event | `packages/runtime/src/inference/connectors/openai-chat-protocol.ts`; `packages/runtime/src/inference/types.ts`; `packages/schemas/src/inference-core.ts`; `api/src/contracts/inference-core.ts` | enrich `tool_call.delta` with `index`/`id?`/`toolName?` |
| Drain loop | `worker/src/run/inference-stage.ts`, `worker/src/run/inference.ts`, `worker/src/run/execute/run-inference.ts` | `onToolCallDelta` (sync), threaded like `onVisibleTextDelta`; cancel-poll + abort while a session is active |
| Recorder | `worker/src/run/execute/document-stream.ts` (new) + wiring in `run-job.ts` | session lifecycle, incremental extraction, ephemeral publish, coalesced durable chunks |
| Partial-JSON util | new shared module (e.g. `packages/schemas/src/partial-json.ts`); `admin/src/facades/designer/hooks.ts` | `extractPartialStringField` — one implementation; designer migrates to it |
| Tool | `packages/runtime/src/builtin-kb-tools.ts`, `worker/src/run/pa-tools/` (new `knowledge-compose.ts`), `worker/src/run/tools.ts`, shared save core factored from `knowledge-write.ts` | `kb_document_compose` |
| Markdown converter | `api/src/lib/markdown.ts` → `packages/knowledge` (api re-exports) | shared `markdownToHtml` |
| Transport | `packages/runtime/src/realtime.ts` (`publishSseEphemeral`), `packages/schemas/src/realtime-sse.ts`, `api/src/realtime/hub.ts` | events + no-replay + ephemeral path |
| API | `api/src/routes/threads.ts` (+ a small service) | SSE hardening; two document-stream GET routes; prisma migration |
| Admin facade | `admin/src/facades/threads/hooks.ts`, new `document-stream.ts` + `document-stream-helpers.ts` (+ node tests) | frame handling, entries, bootstrap, offset merge, reconcile |
| Admin UI | new `DocumentStreamDialog.tsx`, `DocumentStreamChip.tsx`, `StreamingMarkdown.tsx`; `ChannelMessageFeed.tsx` | dialog + chip + renderer, feed wiring |
| PA prompt | PA base-prompt module | compose-tool guidance (agree location first; resolve ids via `kb_list`) |
| Docs | `CLAUDE.md` (SSE event list), this plan → `docs/done/` on completion | keep in sync |

### 5.3 Testing

- **Unit (node):** `extractPartialStringField` (split escapes, `\uXXXX` halves,
  key-in-value traps, absent key); block splitter (fences, nested lists);
  `repairStreamingTail`; recorder (ordering under interleaved flush, oversize
  split, close-idempotence) — mirroring `thinking-recorder.test.ts`.
- **DB-backed:** session/chunk lifecycle + bootstrap endpoint; scoped cleanup
  per AGENTS.md shared-DB rules (no global counts, seed-scoped deletes).
- **Mock-LLM:** extend `@nessie/mock-llm` scenarios with a scripted
  `kb_document_compose` call that streams args in awkward fragment boundaries
  (escape split mid-`\n`); assert the full worker path (session rows, chunk
  content equals the args' markdown field, `stream.document.*` order, saved
  page HTML equals `markdownToHtml(markdown)`). Include non-English/emoji
  content per repo fixture standards.
- **Playwright (mandatory):** load `http://localhost:5455`, drive a mock-LLM
  PA conversation, assert the dialog opens, formatted elements appear
  progressively (poll innerText growth + presence of rendered `<h1>`/`<pre>`
  mid-stream), minimize→chip→reopen, and the final "Open document" lands on
  the KB page. Mobile viewport variant for the sheet layout.

## 6. Key decisions, tradeoffs, and questions for Ondrej

Decisions already taken above (challenge in review if wrong):

1. **Tool-arg streaming (Option A) over sub-inference (B).** Single inference,
   model owns its own document, designer precedent; cost = provider-coverage
   degrade + incremental JSON decoding.
2. **Ephemeral live path + coalesced durable path.** Per-chunk `pg_notify`
   only; durability via `run_document_chunks` at ThinkingRecorder cadence;
   reconnect via offset bootstrap. Diverges from `stream.delta`'s per-token
   durable INSERT deliberately.
3. **Server-side extraction** (not designer-style client-side): clean markdown
   on the wire, one escape-decoder, trivially consumable by any future client.
4. **Save once at tool execution; draft + human publish gate preserved.**
5. **Popup is conversation-local UI state** — auto-open on `start`, minimize to
   chip, no routes/deep-links in v1.

Open questions — input needed:

- **Q1 — publish friction.** PA documents land as agent-authored drafts and
  publication needs `kb_publish_request` + human approval, even in the owner's
  own private "My Docs". For a personal assistant acting for its owner this
  may feel like pointless ceremony. Options: (a) keep the gate everywhere
  (recommended for v1 — one rule, no new policy surface); (b) auto-publish
  when the target space is the owner's private space. Which?
- **Q2 — partial content on cancel/failure.** Recommended: save the partial
  body as a clearly-marked interrupted draft (nothing you watched stream is
  ever lost). Alternative: discard, chat notice only. Confirm?
- **Q3 — v1 scope: PA-only.** `kb_document_compose` is `personalAssistantOnly`
  in v1. Reason: document deltas ride the *thread's* SSE stream, so in a shared
  channel every thread viewer would watch content that may be destined for a
  space they cannot read — a disclosure question PA DMs structurally don't
  have (viewer = owner). Extending to shared agents later needs a
  space-visibility ⊇ thread-visibility gate before publishing deltas. OK?
- **Q4 — non-streaming providers.** On Kimi/prompt-translated (and any
  non-streaming connector) the popup shows "writing…" and the document appears
  complete when it arrives — honest, but not a token stream. Accepting this
  (rather than faking a typewriter, which requirement 1 forbids) — confirm.
- **Q5 — markdown source retention.** v1 saves HTML only (upload-path parity);
  the markdown source lives in session chunks until pruned (7 days). If you
  want the markdown kept permanently (e.g. `KnowledgePageVersion.bodyRef` or
  page metadata), say so now — it's cheap at write time and expensive to
  backfill.
- **Q6 — location agreement UX.** v1 is conversational agreement only. A
  clickable location-picker card (CommsConnectCard precedent) is a natural v2;
  not designed here. Fine to defer?
