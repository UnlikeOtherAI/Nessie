# Live document streaming — PA writes a document while you watch the tokens arrive

**Status:** verified design → Opus builds. No code has been written. Two
adversarial verification passes have run against the codebase and are folded
in below: **Fable** (output-token ceiling, abort plumbing, per-invocation
index scoping, name-enrichment from the accumulation map, replay-list
semantics, ephemeral hub mechanics, offset units, bounded publish queue,
mock-llm gap, session→thread binding) and **Codex Sol** (session identity =
`toolCallId`+invocation, disclosure containment via `consumedSources`,
terminal ordering vs `stream.done`, bootstrap watermark + buffer-then-merge,
budget clamp incl. output allowance in pre-flight, `finish_reason: length`
loop contract, lexical extractor with committed-prefix + duplicate-key
rejection + the streamed-equals-saved assertion, remote-media block, hub
backpressure, ref-accumulate rendering, canonical final render, MiniMax
degrade correction, chat doorway chip, shared REST DTO contracts). A kimix
pass was also launched; fold its findings in if/when it lands. Owner
decisions of 2026-08-13 (markdown `.md` files — no HTML, no output cap,
publish-by-usefulness, discard on stop, not PA-only, address-bar retarget)
are recorded in §6.

## 1. Goal

A user asks their personal assistant (PA) to create a document. In conversation
they agree on a location for it. When the assistant starts writing, a centered
popup opens over the conversation and renders the document as **formatted
markdown, progressively, token-by-token, as the model actually emits them**.
When generation finishes, the document is saved as a real **markdown `.md`
file** (a KB file node — never converted to HTML) at the agreed location, the
popup offers to open it, and an address bar at the bottom of the popup lets the
user retarget where it lands while it is still being written.

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
  (`packages/schemas/src/inference-core.ts:267`,
  `api/src/contracts/inference-core.ts:295`). The worker's drain loop
  (`inference-stage.ts:232-246`) handles only reasoning and output text; the
  tool fragments fall through unread. Today the payload carries only `text` —
  no tool-call `index`/`id`/`name` — so fragments are uncorrelatable until
  enriched. Two wrinkles the enrichment must handle: the canonical OpenAI
  first chunk carries `id` + `function.name` with **empty** `arguments`, so no
  event is yielded for it at all (`openai-chat-protocol.ts:242-248` yields only
  on non-empty argument fragments); and a chunk carrying both `delta.content`
  and `delta.tool_calls` hits the `continue` at
  `openai-chat-protocol.ts:220-225`, silently dropping the tool fragments from
  the yielded stream *and* the accumulation map — a live parsing bug this
  change fixes in passing.
- **Only the OpenAI-compatible protocol streams tool args natively.** Both
  `connectors/kimi.ts` **and** `connectors/minimax.ts` declare
  `toolCallingMode: 'prompt-translated'` — the tool call streams as
  `output_text.delta` text and is parsed only after the stream ends (MiniMax
  reuses `collectChatStream` for text, but its request sends no native tool
  schema, so no `tool_call.delta` can occur). The no-`stream` connector
  fallback (`service.ts:120-127`) emits the whole answer as one synthetic
  delta. Production chat (Ledger DeepSeek adapter, openai-compatible
  protocol) **does** stream tool args; Kimi, MiniMax, and non-streaming
  connectors take the honest atomic degrade (§4.6).
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
- ⚠️ Provider coverage: only OpenAI-compatible connectors (incl. Ledger
  production) stream tool args; Kimi and MiniMax (both prompt-translated) and
  the non-streaming fallback do not. Degrade (§4.8) is *honest*: the popup
  shows a "writing…" state and the document appears when it exists. **Never a
  fake typewriter.**
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
- ❌ The 75 s effective tool timeout (`TOOL_TIMEOUT_MS`,
  `worker/src/run/run-budget.ts:17`) is hostile to a multi-minute generation
  living *inside* a tool call.

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
  // Ordinary builtin like the other kb_* tools — NOT personalAssistantOnly.
  // On by default for the PA (and, like kb_draft_write, for any agent unless
  // toolPolicy disables it). Owner decision 2026-08-13: "available for the
  // personal assistant, and addable to any other agent." Note the disclosure
  // consequence for shared channels in §6 decision 3.
  "description": "Write a full markdown document and save it as a .md file in the Knowledge Base at an agreed location. The user watches the document stream in live, so write the final document directly — no preamble inside `markdown`.",
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

1. **Resolve the effective target.** The args carry the conversationally
   agreed `spaceId`/`parentPageId`; if the user retargeted from the popup's
   address bar mid-stream (§4.4), the session row carries a
   `targetOverride {spaceId, parentPageId}` that **wins over the args** — the
   user's last click beats the model's earlier agreement.
2. Re-run the `kb_draft_write`-equivalent authorization against the effective
   target: access principal via `buildSpaceViewerPrincipal` (delegating PA =
   the owner's identity) → `canWriteSpace`, restricted-tier deny, 200 000-char
   body cap. Same service seam, not a copy — factor the shared core out of
   `worker/src/run/pa-tools/knowledge-write.ts` rather than forking it
   (AGENTS.md "reuse, never fork").
2′. **Disclosure containment.** The run context already carries
   `consumedSources` (`worker/src/run/tool-types.ts:44-51`), whose contract
   says exactly this: tools that persist content — `send_message`, KB writes —
   must consult it so a run holding restricted material cannot write it
   somewhere less restricted. `send_message`
   (`worker/src/run/pa-tools/message-delivery.ts`) is the pattern; the shared
   save core applies the same check against the effective target space's
   audience and **refuses a widening write** (`save_failed`, told to the
   model in words). Conversational agreement is not a server-verifiable
   disclosure authorization; this check is.
3. **Save as a markdown file — never HTML.** Owner decision 2026-08-13: the
   deliverable is a real `.md` file. The handler streams the markdown bytes
   through the one `FileService` chokepoint (quota-gated, storage-accounted,
   like every blob write) as an `Attachment`, then creates a
   `KnowledgePage` with `kind: file`, title `<title>.md`, `authorType: agent`,
   and a `KnowledgePageVersion` whose `attachmentId` is that attachment —
   the exact shape a file upload produces. **Deliberate divergence from the
   HTTP upload path:** `POST /spaces/:spaceId/files` auto-converts markdown
   uploads into HTML `kind: document` pages
   (`api/src/routes/knowledge-base-files.ts`); this tool intentionally does
   not — the `.md` file *is* the artifact. No markdown→HTML conversion
   exists anywhere in this feature. (The `UNSAFE_BODY_PATTERN` HTML guard is
   moot for file bytes; rendering safety is the viewer's job, §4.4/§5.2.)
4. **Publish by usefulness.** When the effective space is the owner's private
   space (`visibility: private` and the acting principal is the owner — e.g.
   "My Docs"), the page is created **published** (`status: published`,
   `publishedVersionId` set): the owner asked for it, watched it stream, and
   there is nobody else to approve it. In any shared space it lands
   `status: draft` and the PA offers `kb_publish_request` in chat (the
   Librarian pattern). This auto-publish is a product decision implemented in
   the shared save core; the human publish route's agent-actor refusal is
   untouched.
5. **Cancel-vs-save has a specified winner.** Immediately before writing, the
   handler re-reads `cancelRequestedAt` and CASes the session
   `streaming → saving` in one conditional update; a Stop that lands first
   wins (nothing saved), a save that CASes first completes and the late Stop
   only cancels the rest of the run. The save also asserts the
   **streamed-equals-saved invariant**: the accumulated streamed markdown must
   byte-equal the final parsed `markdown` argument (§4.2(c)3 guarantees this
   is checkable); on mismatch the session fails without saving — the user
   must never watch one document and get another.
6. Finalize the stream session (§4.3): mark it `saved`, record `pageId` /
   `versionNumber` / `attachmentId`, publish `stream.document.done`.
7. **Durable in-chat doorway** (rule zero). The run's final chat message
   carries server-authored `metadata.documentRef = { sessionId, pageId,
   spaceId, title }` (the `metadata.runStop` precedent), rendered as a
   document chip in the feed — so the result stays reachable after the popup
   closes, across reloads, and for late joiners, without depending on the
   model echoing a correct link.
8. Return to the model: `pageId`, `title`, effective location (space name +
   parent title — including telling the model when a user retarget overrode
   its args), published-or-draft, and character count — **not** the body (the
   model already has it verbatim in its own tool call).

The model keeps `kb_list` / `kb_search` for the location-agreement phase and
`kb_page_read` / `kb_draft_write` / `kb_file` / `kb_publish_request` for
follow-ups; `kb_document_compose` is only the "write it fresh, live" verb.
Prompt guidance for the PA (in the PA base prompt, model-judged as always —
no string matching anywhere): before calling it, confirm the destination with
the user and resolve names to ids via `kb_list`.

### 4.2 Worker: tapping the stream

**(a) Enrich `tool_call.delta`.** Every yielded event carries
`{ index: number, id: string, toolName: string, text }`, populated **from the
connector's accumulation map** (`existing.id` / `existing.name`,
`openai-chat-protocol.ts:228-240`) — never from the current chunk alone,
because on the canonical OpenAI shape the name arrives in a first chunk with
empty arguments that yields no event, and every later fragment carries only
`index` + `arguments`. The same change removes the `continue` at
`openai-chat-protocol.ts:220-225` so a chunk carrying both `delta.content`
and `delta.tool_calls` feeds both paths (today the tool fragments of such a
chunk are silently lost, corrupting even the executed call). Type mirrors:
`runtime/src/inference/types.ts`, `packages/schemas/src/inference-core.ts`,
`api/src/contracts/inference-core.ts`. MiniMax inherits via the shared
protocol. Kimi remains without the event — by design.

**(b) New drain-loop branch, scoped per invocation.** `executeStage`
(`worker/src/run/inference-stage.ts`) gains
`onToolCallDelta?: (event: {index, id, toolName, text}) => void` beside the
two existing callbacks, threaded up through `runInferenceGraph`
(`worker/src/run/inference.ts`) to `createRunInference`
(`worker/src/run/execute/run-inference.ts`) exactly like
`onVisibleTextDelta`. The signature is **synchronous fire-and-forget**
(`void`, not `Promise`): the document pipeline must never add backpressure to
the provider read loop (see (d)).

Correlation is **per inference invocation, never per run**: `index` restarts
at 0 for every HTTP call, and `callInferenceWithRetry`
(`worker/src/run/inference-retry.ts`) re-issues the *same* iteration up to
3 times on transient errors — a mid-stream retry would otherwise re-stream
index 0 into a half-filled buffer. `executeStage` therefore brackets each
attempt with `recorder.beginInvocation(invocationId)` / `endInvocation()`:
`begin` resets all per-index buffers and marks any session still `streaming`
as **`superseded`** (publishing
`stream.document.error {reason:'superseded'}` so the popup resets cleanly
before the replacement session starts); a later iteration's compose call
likewise supersedes a session that never reached a terminal state (failed
save, budget stop between inference and tool batch). This is the only writer
of the `superseded` status.

**Session identity is `(runId, invocationId, toolCallId)`, not the index.**
The index only *routes fragments within one invocation*; the durable session
row persists the provider `toolCallId` (unique per session) plus the
invocation id, because the executed tool call is identified by `toolCallId`
(`worker/src/run/agentic-loop.ts` batch dispatch) — that is how the handler
finds *its* session at save time even with parallel compose calls, retries,
or later iterations in play. `onToolCallStart` is threaded the `toolCallId`
for the non-streaming degrade path (§4.6) for the same reason. The recorder
exposes an **awaitable finalization barrier** (`recorder.settle(toolCallId)`)
that the tool handler awaits before saving, so the handler can never outrun
asynchronous session creation or still-queued deltas.

**(b′) Output-token budget.** The deployment default per-call cap is
**2,048 tokens** (`NESSIE_MODEL_MAX_TOKENS`,
`packages/config/src/index.ts:43`) — a fatal ceiling for a document emitted
as tool-call arguments in one completion. Owner decision 2026-08-13: **no
output cap for the compose turn.** Two required behaviours:

- When `kb_document_compose` is present in the turn's tool array (a
  structural fact, not content inspection), the main-turn call requests
  `min(model capability maxOutputTokens, remaining effective run-token
  allowance − projected input − reserved headroom)` instead of
  `NESSIE_MODEL_MAX_TOKENS` — i.e. the model's maximum, **clamped by the run
  budget**, with no intermediate env knob. The pre-flight token gate
  (`worker/src/run/agentic-loop.ts` / `loop-budget.ts`) must count the
  requested output allowance, not just projected input — today it doesn't,
  and an uncounted multi-thousand-token output could sail past the budget it
  exists to protect. When the clamp leaves too little room for a meaningful
  document, the normal wind-down/budget-stop machinery applies rather than
  dispatching a doomed call.
- `finish_reason: 'length'` while a session is streaming can still occur at
  the model's own hard output limit and is a first-class failure with an
  **explicit loop contract** (today's loop either executes returned tool
  calls or finishes — neither fits): the loop keeps the provider
  `toolCallId`, appends a **synthetic failed tool result** ("document
  exceeded the output window — write a shorter document or split it")
  without invoking the handler, meters the invocation as usual, and
  continues to the next iteration. The session ends
  `failed {reason:'truncated'}` (nothing is saved, §4.7). Multi-call
  continuation is out of scope for v1.

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
3. **Extracts markdown incrementally — as a lexical scanner, not a
   heuristic.** A shared, React-free incremental extractor (new module in
   `@nessie/runtime` or `packages/schemas`; the designer facade's
   `extractPartialContent` is the precedent but is replaced, not ported
   as-is): a top-level JSON lexer that tracks string/escape/nesting state
   across chunk boundaries and emits the decoded value of the top-level
   `markdown` key with two hard invariants — **committed-prefix monotonicity**
   (an incomplete escape (`\`, half of `\uXXXX`, an unpaired surrogate) is
   never emitted as raw text; output only ever grows by appending, so every
   published delta remains a prefix of the final value) and **duplicate-key
   rejection** (a second top-level `markdown` key fails the session:
   `JSON.parse` keeps the *last* duplicate, so without this a stream could
   display one body and save another — the streamed-equals-saved assertion in
   §4.1 step 5 is the belt to this suspender). The admin's designer facade
   migrates to the shared util (one implementation, two callers).
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
   `offset` is the decoded-markdown offset before this fragment, `seq` a
   per-session counter — the client can detect gaps/overlaps exactly.
   **Offsets are UTF-16 code units everywhere** (event, chunk table,
   bootstrap): the unit JS strings natively count in, so client merge
   arithmetic is `offset + content.length` with no encoding step. The
   pg_notify split rule, by contrast, is **byte**-aware: fragments are split
   so the JSON-escaped UTF-8 envelope stays under ~7.5 KB (the 8,000-byte
   NOTIFY cap; 4,096 emoji-heavy code units can exceed it). Publishes are
   serialized on a per-session promise queue (the ThinkingRecorder pattern)
   so ordering holds **without** the drain loop awaiting them; errors are
   swallowed with a `console.warn` (streaming display is never worth failing
   a run). The queue is **bounded**: beyond a depth of 32 unsent entries
   (a degraded Postgres), adjacent offset-contiguous queued fragments merge
   into one — content-preserving and latency-neutral, since it only merges
   what is already backed up, so the real-time requirement is untouched.
   **`seq` is assigned at publish time, after any merge** (never at enqueue),
   so merging can't fabricate gaps or duplicates; the oversized-fragment
   split likewise numbers each piece at publish.
5. **Persists durable chunks, coalesced — in a separate lane.** A second,
   independent queue appends decoded markdown to `run_document_chunks`
   batched at 2 KiB / 250 ms (ThinkingRecorder constants). Two lanes, not
   one: a slow durable INSERT must never delay a later live notify (the §4.6
   audit table depends on this). The durable lane is the
   mid-stream-join/reconnect source of truth; session finalization
   (`settle`, §4.2(b)) awaits **both** lanes.
6. **Finalizes — before `stream.done`, with a crash backstop.** The tool
   handler (§4.1) closes a session `saved`; invocation brackets mark
   `superseded` (§4.2(b)). The ordering constraint "the run terminator is
   published last" cannot be met by hanging finalization off
   `updateRunStatus`, because **every terminal path publishes `stream.done`
   *before* calling `updateRunStatus`** (`completion.ts:167` vs `:217`;
   same shape in `failure.ts` and `cancel-stop.ts`). The contract is
   therefore: **every publisher of `stream.done` first awaits
   `finalizeDocumentSessions(runId)`** — a shared step that drains both
   recorder lanes, terminalizes any non-terminal session, and publishes its
   `stream.document.done`/`error` — so document terminators always precede
   the run terminator. The `updateRunStatus` fusion (the 👀 working-marker
   pattern) remains as the **crash backstop only**: queue redelivery drives
   the run to terminal through it, closing sessions a SIGKILL orphaned; in
   that path the client's zombie-guard (§4.4) already covers the ordering
   gap.

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
                           'budget_stopped' | 'invalid_args' | 'truncated' |
                           'superseded' }
'stream.document.target': { runId, sessionId, spaceId, spaceName,
                            parentPageId?, parentTitle? }
                           // user retargeted from the address bar; keeps a
                           // second open client (e.g. phone + desktop) in sync
```

- **Only `stream.document.delta` joins the hub's no-replay list**
  (`api/src/realtime/hub.ts:222-237`) — that list *withholds* events from
  `Last-Event-ID` reconnects, so putting terminators on it would defeat the
  point. `start/meta/done/error` are published durably (ordinary
  `publishSse`, ≤4 rows per document) and **replay**, exactly like
  `stream.done` (which is deliberately absent from that list today): a
  reconnecting client learns a session started/ended even across the gap.
  Fresh connects rely on bootstrap.
- **Ephemeral events need three explicit hub behaviours** (today's hub
  assumes every notification has a sequence): they are written with **no
  `id:` line** (`formatSseEvent`, `hub.ts:54-55`, currently unconditional —
  an undefined sequence would literally set the client's Last-Event-ID to
  the string `"undefined"`); they **never assign `connection.lastSequence`**
  (`hub.ts:113-131`); and during connect-hydration they bypass the
  sequence-sorted `pending` buffer (`hub.ts:245`) and are dropped — the
  bootstrap that hydration triggers covers them by construction.
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
       // markdown = concatenated run_document_chunks; offset = its length
       // in UTF-16 code units (same unit as delta offsets)
```

The per-session route additionally verifies
`session.threadId === :threadId && session.organizationId === actor org`
before answering — `sessionId` is a global UUID, and the thread gate alone
would let any authenticated user with *some* readable thread fetch any org's
streamed markdown by UUID. 404 on mismatch, indistinguishable from absent.

One mutation route backs the popup's address bar (§4.4):

```
POST /api/threads/:threadId/document-streams/:sessionId/target
  { spaceId, parentPageId? }
```

Same thread + session-binding gate, **plus** the same owner-principal
`canWriteSpace` check the save will make (fail at click time, not save time).
While the session is `streaming`, it persists `targetOverride` on the session
row and publishes `stream.document.target`; if the session is already `saved`,
it instead moves the existing page through the existing
`POST /api/knowledge-base/pages/:pageId/move` service core (one behaviour from
the user's seat: "the address bar always works"). Terminal-failed sessions →
409. Race with the save transaction: the save reads `targetOverride` inside
the same transaction that creates the page, so a retarget either lands before
the read (wins) or the route sees `saved` and takes the move path.

Client contract — **buffer, then merge on the offset watermark**: the
bootstrap response is an atomic watermark `{markdown, offset, lastSeq}` read
from the durable lane. While a bootstrap is in flight, live deltas are
buffered, not applied. On response: drop buffered deltas entirely below
`offset`, apply the straddling tail, then apply the rest in `seq` order —
**never across a hole**. Because durable chunks trail the live lane by
≤250 ms, a bootstrap can return an offset *behind* the first buffered delta
with the gap's deltas already dropped by the hub during connect-hydration
(ephemeral events bypass the hydration buffer, above); in that case the
client re-fetches the bootstrap until the durable offset reaches the first
buffered delta's offset. The same rule covers a `seq` gap detected any time
later. This is the one place the durable lag is observable, and the
re-fetch-until-contiguous rule closes it exactly.

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
  "Writing document…" until `meta`), a live character counter, and the
  streaming dots. **Footer: the address bar** — a full-width control showing
  the effective target as a path (`Space › Folder › <title>.md`), seeded from
  `stream.document.meta`, updated by `stream.document.target`. Clicking it
  opens a folder picker dropdown (spaces from `GET /api/knowledge-base/spaces`,
  outline drill-down per space — a lightweight list reusing the knowledge
  facade queries, not a fork of `KnowledgeFilesystemBrowser`) which POSTs the
  retarget route (§4.3): before save it re-aims the save; after save it moves
  the file. Beside it while streaming: **Hide** (minimize) and **Stop**
  (§4.7); after `done`: **Open document** (navigates
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

1. **Ref-accumulate → one commit per frame.** Deltas append to a mutable ref
   (an external store, not React state — a per-delta `setState` would
   re-render the owning feed for every provider chunk regardless of any
   child-level rAF gate); a `requestAnimationFrame` callback commits the ref
   into React state at most once per frame, updating the markdown and the
   character counter together. The one-frame bound is the target on an
   unblocked main thread, not an unconditional guarantee — but arrival is
   never delayed by rendering: the ref holds every byte the moment it comes
   off the wire.
2. **Block-freeze parsing, canonicalized at the end.** The accumulated
   markdown splits into blocks at top-level blank lines **outside fenced
   code** (a pure splitter in `document-stream-helpers.ts`, fence-aware for
   backtick *and* tilde fences of any length ≥3 and ignoring fence-lookalikes
   inside inline code spans; node-tested). All blocks except the final one
   are *stable*: rendered once through
   `<MessageMarkdown renderInlineText={identity}>` and memoized
   (`React.memo` on `(blockText)`). Only the live tail block re-parses per
   frame — cost per frame is O(tail), not O(document). Per-block parsing is
   knowingly not markdown-semantics-preserving for whole-document constructs
   (reference-style link definitions, loose-list spacing across blocks), so
   on `stream.document.done` the dialog swaps in **one canonical full-document
   render** through a single `MessageMarkdown` — mid-stream display is an
   honest approximation, the final view is exact, and the test suite asserts
   final-DOM equivalence between the two paths on well-formed documents.
2′. **No remote media, ever.** The streaming dialog and the `.md`
   `FileNodeViewer` preview render through a `MessageMarkdown` variant whose
   `img` handling replaces remote sources with an inert placeholder
   (`MessageMarkdown` today has no `img` override, and the production CSP is
   report-only with any-HTTPS `img-src`): a prompt-injected document must not
   be able to beacon viewer metadata or exfiltrate generated content through
   an attacker-named image URL, in a dialog that auto-opens. Tests assert
   that rendering hostile markdown triggers zero network requests.
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

The agreement phase starts as **conversation**: the PA already has `kb_list`
to enumerate spaces and walk a space's outline, well-known anchors ("My
Docs", "Project Documents", ticket folders), and title→id resolution. The PA
proposes ("I'll put it in *Project Documents › Meetings*, under the 2026
folder — ok?"), the user confirms in their own words, the model judges the
confirmation (never string-matched — AGENTS.md), and only then calls
`kb_document_compose` with resolved UUIDs. From the moment the popup opens,
the **address bar takes over as the location control** (§4.4): it is the
visible receipt of the agreement, and clicking it retargets the save — the
user's click always beats the model's earlier choice, with no need to
interrupt the stream or re-negotiate in chat.

Save semantics (owner decisions 2026-08-13, recorded in §6):

- The file is created **once, at tool execution** — not progressively. A
  half-generated file would churn attachment versions and storage-accounting
  events per flush for no user value; the durable stream lives in
  `run_document_chunks` until the save.
- **The artifact is a `.md` file node** — `KnowledgePage {kind: file}` + an
  `Attachment` holding the exact markdown bytes, stored through the
  `FileService` chokepoint (quota-gated by `Budget.storageLimitBytes`,
  `StorageUsageEvent`-accounted, like every other blob). No HTML is produced
  anywhere in this feature; the upload path's md→HTML auto-conversion is
  deliberately bypassed (§4.1 step 3).
- **Published where that is obviously right, draft elsewhere:** owner-private
  target space → created `published`; shared space → `draft` + a
  `kb_publish_request` offer in chat (§4.1 step 4).
- **The KB must render what it stores** (rule zero: the capability is not
  done until the person can reach it): `FileNodeViewer.tsx` gains a markdown
  preview branch — `.md` file versions render through
  `<MessageMarkdown renderInlineText={identity}>` (the message renderer, not
  TipTap), with the existing raw-download affordance unchanged. Without this
  the saved document would open as an opaque file card.
- Missing intermediate folders are **not** auto-created; the PA targets an
  existing parent or the space root, and the address-bar picker only offers
  existing folders. Folder creation from the picker is a natural v2.

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
| Slow-client backpressure | `res.write() === false` (hub currently ignores it): ephemeral document deltas to that connection are dropped, the resulting `seq` gap makes the client repair via bootstrap; a persistently lagging connection is closed so reconnect fixes it | n/a (repair path) |
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
| **User clicks Stop** | Dialog calls existing `POST /api/runs/:id/cancel` (confirm-in-dialog first). Cooperative cancel today only polls between iterations/tool batches (`agentic-loop.ts:263, 463`) — during argument streaming nothing would notice, and **no abort plumbing exists anywhere in the inference stack today** (every connector calls bare `fetch` with no `signal`). This is a real, bounded subsystem addition, spelled out so nobody discovers it mid-build: (1) `InferenceRequest` gains an optional `AbortSignal`, threaded from `executeStage` through `InferenceService.stream()` into every connector's `fetch`; (2) while a document session is active, an **independent poller** (a timer owned by the recorder, not an inline check in the drain loop — an awaited DB probe inside the loop would backpressure the provider read) checks `cancelRequestedAt` at ≥1 s intervals and fires the controller; (3) a **typed `InferenceAbortedError` that survives every wrapper** — `executeStage` and `connector-invocations.ts` currently replace connector errors with new generic ones, and `classifyError` reads only the outer message, so a bare AbortError would be laundered into `transient`/`unknown` and `callInferenceWithRetry` would *retry the whole document generation* (re-streaming it) or surface an apology the loop delivers as a completed reply; the typed error is preserved (or re-wrapped with `cause` and classified through the chain), classified as aborted, and bypasses retry entirely; (4) `executeStage`/`agent-loop` treat that outcome, when `cancelRequestedAt` is set, as the cooperative-cancel exit, so the run leaves through the existing `cancel-stop.ts` machinery. Session → `cancelled`, `stream.document.error {reason:'cancelled'}`. **Nothing is saved** (owner decision 2026-08-13: "if the user stops the writing, we're not gonna save"); the streamed text stays visible and copyable in the dialog, and in `run_document_chunks` until pruned. |
| **Run fails / crashes mid-stream** | `failure.ts` path already publishes `stream.done`; the lifecycle terminal fusion (§4.2(c)6) marks any non-terminal session `failed` and publishes `stream.document.error {reason:'run_failed'}` first. Worker hard-crash: queue redelivery drives the run to a terminal status through the same `updateRunStatus`, closing the session then — the `run-job.ts` `finally` close is best-effort fast-path only. The client's zombie-guard (§4.4) covers the gap meanwhile. |
| **Budget stop / wind-down** | `budget-stop.ts` aborts like a failure for the in-flight turn: session `failed`, `reason:'budget_stopped'`, nothing saved. The wind-down injection (80 %) happens between turns, so a compose call that already started streaming is never truncated by wind-down itself. |
| **Args invalid at execution** (bad `spaceId`, access denied, body cap, storage quota) | The stream looked fine but the save is refused: session `failed`, `reason:'save_failed'` (or `invalid_args`), nothing saved; the tool returns the error to the model, which apologizes / retries with a corrected location in the same run — a brand-new session, popup follows the newest. Dialog shows the error with the streamed content still visible (copyable), so nothing the user watched is lost. |
| **SSE payload oversize / notify failure** | Fragments >4 KiB split; publish errors are swallowed (warn) — the durable chunk path and bootstrap self-heal the client via the `seq` gap → re-bootstrap rule. |
| **Two sessions at once** | Dialog binds to the newest `streaming` session; earlier ones chip-ize. |
| **No partial saves, ever** | A save happens in exactly one place — the tool handler, on a complete, parsed, authorized document (§4.1). Every interruption path (cancel, failure, budget, truncation, supersession) discards: session terminal, nothing written to the KB or object storage, streamed text preserved read-only in the dialog and in `run_document_chunks` until pruned. This removes the interrupted-draft machinery entirely (owner decision 2026-08-13). |

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
  invocationId   String                     // inference attempt that produced it
  toolCallId     String                     // provider tool-call id — THE identity
                                            // the executing handler joins on
                                            // (unique per session; index restarts
                                            // per invocation and is not stored)
  status         RunDocumentSessionStatus   // streaming|saving|saved|failed|cancelled|superseded
  title          String?
  spaceId        String?  @db.Uuid          // from args, via meta parse
  parentPageId   String?  @db.Uuid
  overrideSpaceId      String? @db.Uuid     // user retarget from the address bar;
  overrideParentPageId String? @db.Uuid     // wins over args at save (§4.1 step 1)
  pageId         String?  @db.Uuid          // set on save
  attachmentId   String?  @db.Uuid          // the .md file's Attachment
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
for >7 days. Session rows stay: **deliberately machine-only in v1** (rule
zero's written exception) — they back the bootstrap endpoint, crash
re-terminalization, and debugging; no owning surface is added, and if one
ever is, the natural home is the run's activity panel
(`RunLifecyclePanel.tsx`), not a new page.
Index-creation lint rule: neither table is on the hot-table list, plain
indexes fine. Also note `worker/src/run/execute/run-job.ts` already sits at
528 lines (over the 500-line cap): the recorder wiring lands together with a
seam split of run-job (the cap is an architectural signal, and the
implementer should split along the existing setup/loop/finalize seams rather
than grow the file).

### 5.2 Change map (for the implementer)

| Area | Files | Change |
|---|---|---|
| Provider event | `packages/runtime/src/inference/connectors/openai-chat-protocol.ts`; `packages/runtime/src/inference/types.ts`; `packages/schemas/src/inference-core.ts`; `api/src/contracts/inference-core.ts` | enrich `tool_call.delta` with `index`/`id?`/`toolName?` |
| Drain loop | `worker/src/run/inference-stage.ts`, `worker/src/run/inference.ts`, `worker/src/run/execute/run-inference.ts` | `onToolCallDelta` (sync), threaded like `onVisibleTextDelta`; invocation brackets (`beginInvocation`/`endInvocation`); compose-aware `maxOutputTokens` raise; cancel-poll while a session is active |
| Abort plumbing | `packages/runtime/src/inference/` (request type + `service.ts` + all connectors' `fetch`), `worker/src/run/error-classification.ts`, `worker/src/run/inference-retry.ts`, `worker/src/run/agentic-loop.ts` | optional `AbortSignal` end-to-end; abort branch in `classifyError` that bypasses retry; aborted-outcome → cooperative-cancel exit (§4.7 Stop row) |
| Recorder | `worker/src/run/execute/document-stream.ts` (new) + wiring in `run-job.ts` and `lifecycle.ts` (`updateRunStatus` terminal fusion, working-marker pattern) | session lifecycle, incremental extraction, ephemeral publish, coalesced durable chunks, bounded queue |
| Partial-JSON util | new shared module (e.g. `packages/schemas/src/partial-json.ts`); `admin/src/facades/designer/hooks.ts` | `extractPartialStringField` — one implementation; designer migrates to it |
| Tool | `packages/runtime/src/builtin-kb-tools.ts`, `worker/src/run/pa-tools/` (new `knowledge-compose.ts`), `worker/src/run/tools.ts`, shared save core factored from `knowledge-write.ts` | `kb_document_compose` |
| File save | shared save core factored from `worker/src/run/pa-tools/knowledge-write.ts`; `FileService` (existing chokepoint) | `.md` `Attachment` + `KnowledgePage {kind: file}` + version; owner-private auto-publish; `targetOverride` honored in the save transaction |
| KB viewer | `admin/src/components/features/knowledge/FileNodeViewer.tsx` | markdown preview branch for `.md` file versions via `MessageMarkdown` (rule zero: the saved file must be readable where it lives) |
| Address bar | new `DocumentTargetBar.tsx` + folder-picker dropdown (knowledge facade queries); retarget route `POST …/document-streams/:sessionId/target` in the document-streams service | live retarget → `targetOverride` or page move; `stream.document.target` sync |
| Transport | `packages/runtime/src/realtime.ts` (`publishSseEphemeral`), `packages/schemas/src/realtime-sse.ts`, `api/src/realtime/hub.ts` | events + no-replay + ephemeral path |
| API | `api/src/routes/threads.ts` + a **new** `api/src/services/document-streams.ts` (threads.ts is at 431 lines — the routes stay thin, the service owns the queries) | SSE hardening; two document-stream GET routes (with session→thread+org binding check); prisma migration |
| Mock LLM | `packages/mock-llm` (scenario schema + `src/server.ts`) | today the server streams each tool call's whole `arguments` in **one** SSE chunk with no pacing (`server.ts:169-188`) — add scenario-controlled fragmentation + inter-chunk delay for tool args, or none of §5.3's progressive assertions can run |
| Admin facade | `admin/src/facades/threads/hooks.ts`, new `document-stream.ts` + `document-stream-helpers.ts` (+ node tests) | frame handling, entries, bootstrap, offset merge, reconcile |
| Admin UI | new `DocumentStreamDialog.tsx`, `DocumentStreamChip.tsx`, `StreamingMarkdown.tsx`; `ChannelMessageFeed.tsx` | dialog + chip + renderer, feed wiring |
| Chat doorway | message metadata `documentRef` (server-authored, `runStop` precedent) + a document chip in `ChannelMessageRow`/feed | durable in-chat link to the saved file (rule zero) |
| Shared contracts | `@nessie/schemas` — document-stream REST DTOs (bootstrap/list/target) parsed by API and imported by admin, beside the SSE event schemas | no inline one-off DTOs |
| Hub backpressure | `api/src/realtime/hub.ts` | `write() === false` policy: drop ephemeral deltas for that connection (seq-gap → client repairs), close persistently lagging connections |
| Prompt guidance | agent base-prompt module | compose-tool guidance (agree location first; resolve ids via `kb_list`) |
| Docs | `CLAUDE.md` (SSE event list), `docs/deployment.md` (retention/pruning + budget-clamp behaviour), `docs/shared-type-contracts-spec.md` (new SSE/REST contracts), this plan → `docs/done/` on completion | keep in sync |

### 5.3 Testing

- **Unit (node):** the incremental extractor (split escapes, `\uXXXX` halves
  and unpaired surrogates, key-in-value traps, absent key, **duplicate
  top-level `markdown` keys → session failure**, committed-prefix
  monotonicity under every escape-boundary split); block splitter (backtick
  *and* tilde fences, long fences, fence-lookalikes in inline code, loose
  lists, reference definitions) + final-DOM equivalence of block-frozen vs
  canonical render; `repairStreamingTail`; hostile-markdown render makes
  zero network requests; recorder (ordering under interleaved flush,
  publish-time seq after merge, oversize split, settle barrier,
  close-idempotence) — mirroring `thinking-recorder.test.ts`.
- **DB-backed:** session/chunk lifecycle + bootstrap endpoint; scoped cleanup
  per AGENTS.md shared-DB rules (no global counts, seed-scoped deletes).
- **Mock-LLM:** extend `@nessie/mock-llm` scenarios with a scripted
  `kb_document_compose` call that streams args in awkward fragment boundaries
  (escape split mid-`\n`); assert the full worker path (session rows, chunk
  content equals the args' markdown field, `stream.document.*` order, saved
  attachment bytes byte-identical to the args' `markdown` value, correct
  published/draft status per target-space visibility, `targetOverride`
  winning over args). Include non-English/emoji content per repo fixture
  standards.
- **Playwright (mandatory):** load `http://localhost:5455`, drive a mock-LLM
  PA conversation, assert the dialog opens, formatted elements appear
  progressively (poll innerText growth + presence of rendered `<h1>`/`<pre>`
  mid-stream), minimize→chip→reopen, and the final "Open document" lands on
  the KB page. Mobile viewport variant for the sheet layout.

## 6. Key decisions and tradeoffs (all questions resolved)

Architectural decisions (challenge in review if wrong):

1. **Tool-arg streaming (Option A) over sub-inference (B).** Single inference,
   model owns its own document, designer precedent; cost = provider-coverage
   degrade + incremental JSON decoding.
2. **Ephemeral live path + coalesced durable path.** Per-chunk `pg_notify`
   only; durability via `run_document_chunks` at ThinkingRecorder cadence;
   reconnect via offset bootstrap. Diverges from `stream.delta`'s per-token
   durable INSERT deliberately.
3. **Server-side extraction** (not designer-style client-side): clean markdown
   on the wire, one escape-decoder, trivially consumable by any future client.
4. **Save once at tool execution.** No progressive page churn; interruptions
   discard (below).
5. **Popup is conversation-local UI state** — auto-open on `start`, minimize to
   chip, no routes/deep-links in v1; the footer address bar is the location
   control from the moment the popup opens.

Product decisions from the owner (2026-08-13), all folded into the sections
above:

- **No output-token cap for the compose turn** — request the model's maximum;
  the run budget is the only envelope (§4.2(b′)).
- **Markdown files, no HTML.** The artifact is a `.md` file node
  (`kind: file` + attachment via `FileService`); the upload path's md→HTML
  conversion is deliberately not used; `FileNodeViewer` gains a markdown
  preview so the saved file is readable in place (§4.1 step 3, §4.5).
- **Publish by usefulness:** owner-private space → created published; shared
  space → draft + `kb_publish_request` offer (§4.1 step 4).
- **Stop discards.** No partial saves on cancel — nor on any other
  interruption; the streamed text stays copyable in the dialog (§4.7).
- **Not PA-only.** Ordinary builtin like the other `kb_*` tools — on for the
  PA and available to any agent via tool policy. Consequence accepted: in a
  shared channel the deltas are visible to thread viewers, the same audience
  an agent's chat message already reaches; the *saved file's* access is
  governed by the target space exactly as today. (§4.1)
- **Non-streaming providers wait honestly** — "writing…", then the document
  appears when it arrives; never a fake typewriter (§4.6).
- **Location = chat first, then the address bar.** Conversational agreement
  seeds the target; the popup's footer address bar with its folder picker can
  retarget mid-stream (override before save, move after save) (§4.3, §4.4,
  §4.5).

---

## 7. Delta editing + edit-following viewport (shipped 2026-08-14)

Composing a document was only half of it: asking for a change to an existing
document should not regenerate the whole thing, and the person should be able to
watch the change land where it belongs.

**`kb_document_edit`** takes `pageId` + `edits: [{find, replace}]`. Only the
changed passages are generated. `find` must match the current document exactly
once — anything else is refused in words rather than guessed at, and the live
preview skips an anchor it cannot place so a viewer never sees a change that
will not be saved. An empty `replace` deletes.

**Anchor before text.** An edit is published (`stream.document.edit
{editIndex, offset, removeLength}`) the moment its `find` value closes, before
any replacement text exists. That ordering is the whole reason the viewport can
move to the change site and wait there instead of revealing after the fact
where the change happened. Models emit arguments in schema order, so `find`
naturally arrives first.

**Positions, not appends.** `stream.document.delta.offset` is now the absolute
insertion point in the composed document, and the client applies deltas in
`seq` order — offsets stop being monotonic once edits land mid-document, so
offset-based dedup would be wrong. Composing a new document is the degenerate
case: one edit at offset 0 removing nothing, then increasing offsets.

**Durable lane switches to snapshot mode for edits.** A log of appends cannot
represent a change in the middle of a document. Bootstrap concatenates chunks
in id order either way, so one replaced snapshot row reads back correctly with
no API change. The base document is written to that lane *before*
`stream.document.start` is published, so a client bootstrapping on the event
sees the document rather than an empty page.

**Two implementations, deliberately.** The streaming tracker
(`document-stream-edit.ts` `createDocumentEditTracker`) and the save
(`applyDocumentEdits`) apply the edits independently, and the save asserts they
produced the same document. Collapsing them would turn a real check into a
restatement.

### Edit-following viewport

The change cursor stays vertically centred in the popup while text is being
written, with two rules that come straight from how it should feel:

- **Clamped, never padded.** The scroll target is clamped to
  `[0, scrollHeight - clientHeight]`. Near the end of a document the clamp
  naturally stops centring and the text simply grows upward — which is what
  "no white space at the bottom" means. Spacer elements to force centring are
  forbidden.
- **Stable, not twitchy.** A deadzone suppresses sub-threshold corrections so
  continuous writing does not jitter the page; a new `stream.document.edit`
  (a deliberate jump the user wants to see) re-engages following and animates.
  Manual scrolling releases the follow, with an affordance to re-engage.

### Leaving mid-write

While a session is `streaming`/`saving` the admin registers a `beforeunload`
guard, and closing the dialog asks first. The confirmation offers honest
choices, because hiding is *not* destructive: **Keep writing** (minimise to the
chip, generation continues), **Stop and discard** (cancels the run — nothing is
saved, the established behaviour), **Cancel**. The guard is removed the moment
no session is active, so it can never block ordinary navigation.
