# Agent thinking bubbles + reply placement (2026-08-05)

Owner-requested rules for how agents communicate in channels, and a live
"agent is thinking" surface. Two workstreams: **(A) reply placement** and
**(B) thinking bubbles**. This doc is the implementation brief; file:line
references were verified on branch `claude/agent-communication-thinking-4c7522`.

## Product rules (from the owner, verbatim intent)

1. **Addressed agent → threaded reply.** If a user @mentions a personal
   assistant or addresses an agent, the agent replies in a reply thread under
   the triggering message. (Already the #233 default.)
2. **Threads are a tidiness tool, not a mandate.** If the agent's response
   requires attention *in a thread's context*, it replies in that thread. If
   it is "just a message" (a standalone contribution to the room), it posts
   in the main channel window. This judgment is **model-made, never
   string-matched** (AGENTS.md rule).
3. **Thinking bubble.** Whenever an agent is about to send a message, a
   thinking bubble from that agent appears where the reply will land — the
   bottom of the reply thread, or the bottom of the main chat window — so
   everyone viewing the channel can see a reply is coming.
   - Visual: **not a message row** — a full-width bubble with **dashed
     borders**, showing the last **1–2 lines** of the live thought process;
     new content pushes old lines up and off (ticker). The bubble itself
     discards what scrolls off.
   - **Tap/click → centered popup** showing the *full* thought process so
     far, streaming live.
   - The full thought process must be **retrievable** (persisted) so the
     complete dialogue can be displayed — the bubble is lossy, the record is
     not.

## What already exists (verified)

- **Streaming inference is always on.** `buildDirectRoute` hardcodes
  `streamLive: true` (`worker/src/run/inference.ts:99`). `executeStage`
  consumes the provider stream and forwards `reasoning_text.delta` to
  `onVisibleReasoningDelta` without accumulating it
  (`worker/src/run/inference-stage.ts:234-238`). OpenAI-compatible
  (`reasoning_content`, `openai-chat-protocol.ts:214-217`) and Kimi
  (`thinking_delta`, `kimi-anthropic-protocol.ts:306-307`) emit reasoning;
  minimax does not (bubble then shows tool lines only).
- **SSE events already flow.** `stream.start` (`run-job.ts:297`),
  `stream.reasoning` (`agent-loop.ts:93`), `stream.delta`, `stream.done`
  (completion/failure/cancel + external-conversation) are published per
  thread via `PgRealtimeTransport.publishSse` — which **INSERTs into
  `thread_stream_events` then pg_notify**
  (`packages/runtime/src/realtime.ts:227`). One row per provider delta.
- **The hub deliberately never replays `stream.*` from backlog**
  (`api/src/realtime/hub.ts:223-234`) — live-only, so a mid-run joiner sees
  nothing and there is no per-run retrieval (only index is
  `(thread_id, id)`).
- **The admin already receives and accumulates reasoning** — and drops it.
  `useThreadStream` (`admin/src/facades/threads/hooks.ts:111`) tracks
  `pendingMessages[{runId, agentId, content, reasoningContent}]`;
  `reasoningContent` is never rendered (`ChannelMessageFeed.tsx:327-364`
  renders only `content`). The reply panel passes `pendingMessages={[]}`
  (`ThreadReplyPanel.tsx:269`).
- **Reply placement chokepoint**: `resolveReplyRootMessageId`
  (`worker/src/run/execute/run-job.ts:70-74`) → `context.replyRootMessageId`,
  consumed by prompt scoping (`loadConversation`, run-job.ts:279) and all
  terminal message-create paths (completion/cancel/failure/budget-gate).
  Structural top-level carve-outs that MUST stay unconditional: DeepWater
  handoff (`handoffLocator`), external agents (`external_mcp`), PA delegating
  into a shared channel (`completion.ts:47-59`).
- **Engagement is model-judged** in `decideAgentEngagement`
  (`packages/runtime/src/orchestrator.ts:53`): @mention fast path, else one
  LLM call returning `{action, agentId}` JSON; PA DMs bypass via
  `resolvePersonalAssistantDecisions` (`worker/src/run/orchestrate.ts:37`).
  Runs are created in `orchestrate.ts:287-337` ($transaction, sets
  `triggerMessageId`).
- **mock-llm cannot emit reasoning yet** (`MockTurnSchema` strict,
  `packages/mock-llm/src/scenario.ts:58-71`; `streamCompletion`,
  `src/server.ts:117-181`).

## Design decisions

1. **Placement is decided before the run starts** (not at reply time), so the
   bubble can anchor to the correct surface from the first thinking token.
2. **Placement precedence** (first match wins), applied in
   `resolveReplyRootMessageId`:
   1. DeepWater handoff / external-agent / PA-delegation carve-outs →
      top-level (byte-identical behavior, untouched).
   2. Trigger message is itself in a reply thread → that root (structural
      conversation continuity).
   3. `Run.replyPlacement === 'channel'` → top-level ("just a message").
   4. Default → thread rooted at the trigger message (#233 behavior).
3. **Who judges placement**: the existing engagement-decision LLM call gains
   one field. @mention fast path and PA-DM bypass stamp `'thread'`
   structurally (rule 1 = structural fact). No new inference call, no
   keyword heuristics anywhere.
4. **Thinking transport stays on the per-thread SSE stream** (channel main
   view + thread panel + DM drawer all already consume it; per
   `docs/shared-type-contracts-spec.md:174-176` chat streaming belongs on
   SSE, not WS).
5. **Durable thought log = new `run_thinking_chunks` table**, written by a
   per-run recorder with coalesced flushes — NOT the per-delta
   `thread_stream_events` rows (unindexed per run, unbounded, token-granular,
   and hub-excluded from replay). The recorder also coalesces the SSE
   reasoning publishes (one publish per flush), which *reduces* existing
   `thread_stream_events` write volume.
6. **Tool activity is part of the thought process.** Each tool-call start
   appends a `tool` chunk (`toolName: inputSummary` — already the sanitized
   summary shown on the Activity page).
7. **Mid-run joiners bootstrap over REST**, not SSE backlog: a small
   endpoint returns active runs' anchors + accumulated logs for a thread.
   Chunk ids let the client merge fetched history with live events without
   duplication.

## Workstream A — model-judged reply placement

### A1. Schema (`api/prisma/schema.prisma` + migration)

- `enum RunReplyPlacement { thread channel }` (map `run_reply_placement`).
- `Run.replyPlacement RunReplyPlacement? @map("reply_placement")` — nullable;
  null ≡ historical default (thread). No new index.
- `Run.replyRootMessageId String? @db.Uuid @map("reply_root_message_id")` —
  the **resolved** anchor, persisted by the worker right after
  `resolveReplyRootMessageId` (single `run.update` before `stream.start`).
  Plain uuid, no relation (mirrors `replyParticipantIds` style). This keeps
  the resolution logic in exactly one place (worker); the API bootstrap
  endpoint only reads it. Placement (`replyPlacement`) is the pre-run
  judgment *input*; this column is the resolved *output* including the
  structural carve-outs.

### A2. Orchestrator (`packages/runtime/src/orchestrator.ts`)

- `OrchestratorDecision` reply variant gains
  `replyPlacement?: 'thread' | 'channel'`.
- @mention fast path (L81-94): `replyPlacement: 'thread'`.
- LLM prompt: add a rule instructing the model to also return
  `"replyPlacement"` for `reply` actions, described semantically (reply that
  answers/continues the asker's message and belongs to that exchange →
  `"thread"`; standalone contribution/announcement to the whole room →
  `"channel"`; when unsure → `"thread"`). Describe meaning only — no example
  keyword lists, works in any language.
- Parse: accept only literal `'thread'`/`'channel'`, else omit (fail-silent
  to default, matching existing parse style).

### A3. Worker orchestrate driver (`worker/src/run/orchestrate.ts`)

- `resolvePersonalAssistantDecisions` decisions: `replyPlacement: 'thread'`.
- Run-create transaction (L287-337): persist
  `replyPlacement: decision.replyPlacement ?? null`.
- Restart (`api/src/services/runs.ts:262`): copy `replyPlacement` from the
  original run onto the new one.

### A4. Run execution (`worker/src/run/execute/run-job.ts`)

- `resolveReplyRootMessageId(triggerMessage, handoffLocator, replyPlacement)`
  implementing the precedence above; `loadRunContext`
  (`execute/lifecycle.ts:81`) selects `replyPlacement` onto the context.
- All downstream consumers (`loadConversation`, completion, cancel-stop,
  failure, budget-gate) keep reading `context.replyRootMessageId` — no other
  changes.
- Extend `worker/src/run/execute/reply-placement.test.ts` with the matrix:
  handoff × in-thread trigger × placement (`thread`/`channel`/null).
- Orchestrator tests: scripted modelClient returning placement JSON;
  fixtures must include non-English/slang/misspelled messages (AGENTS.md).

## Workstream B — thinking bubbles

### B1. Schema

```prisma
enum RunThinkingChunkKind { reasoning tool }

model RunThinkingChunk {
  id        BigInt               @id @default(autoincrement())
  runId     String               @map("run_id") @db.Uuid
  kind      RunThinkingChunkKind
  content   String
  createdAt DateTime             @default(now()) @map("created_at")
  run       Run                  @relation(fields: [runId], references: [id], onDelete: Cascade)

  @@index([runId, id])
  @@map("run_thinking_chunks")
}
```

Per-run order = `id` order (one writer per run; queue lock renewal guarantees
no concurrent executor). New table → plain index is fine under the migration
lint (only `messages`/`task_events`/`runs`/`audit_logs` need CONCURRENTLY).

### B2. Realtime contracts (`packages/schemas/src/realtime.ts`)

- `SseEventMap` changes:
  - `'stream.start'`: add `rootMessageId?: string | null` (the reply anchor —
    `context.replyRootMessageId ?? null`).
  - `'stream.reasoning'`: add `chunkId?: string` (durable chunk id, stringified
    BigInt).
  - NEW `'stream.thinking.tool'`: `{ runId: RunId; content: string; chunkId?: string }`.
- Register the new SSE event name wherever SSE names are enumerated; hub:
  add `'stream.thinking.tool'` to the ephemeral no-replay list
  (`api/src/realtime/hub.ts:227-234`).
- External-conversation `stream.start` (`external-conversation.ts:333`)
  passes `rootMessageId: null` explicitly.

### B3. Worker ThinkingRecorder (`worker/src/run/execute/thinking-recorder.ts`, new)

Per-run object created in `run-job.ts` alongside the loop:

- `appendReasoning(delta)` — buffers; flush when buffer ≥ 2 KiB or 250 ms
  elapsed since first unflushed char.
- `appendToolLine(toolName, inputSummary)` — flushes pending reasoning, then
  writes the tool chunk immediately.
- Flush = `prisma.runThinkingChunk.create` (get id) → `publishSse` with
  `chunkId` (`stream.reasoning` for reasoning, `'stream.thinking.tool'` for
  tool lines). One durable row + one SSE event per flush (this *replaces* the
  current per-delta `stream.reasoning` publish, cutting `thread_stream_events`
  spam).
- `close()` — final flush; idempotent. **Stream contract: `stream.done` is
  always last.** run-job closes the recorder immediately after the loop
  returns (covers completion/cancel/budget paths), at the top of its `catch`
  (covers the failure and retry-throw paths), and again in `finally` as a
  no-op safety net — so no thinking event is ever published after the
  stream terminator.
- Failures inside the recorder are swallowed with a `console.warn` — thinking
  capture must never fail a run.

Wiring (`worker/src/run/execute/agent-loop.ts`):

- `mainInferenceCallbacks.onVisibleReasoningDelta` → `recorder.appendReasoning`
  (replaces the direct `publishSse`).
- `onToolCallStart` → `recorder.appendToolLine(toolName, summarizeToolInput(args))`
  (keep existing WS `agent.tool.start` publish).
- Delegate sub-agent inference stays silent (unchanged).
- `stream.delta` (visible reply text) is untouched.

### B4. API endpoints (`api/src/routes/threads.ts` + service)

Auth for both: `findThreadForUser` (same gate as the SSE stream route), plus
run→thread ownership check.

1. `GET /api/threads/:threadId/runs/:runId/thinking` — full log:
   `{ run: { id, agentId, status, rootMessageId }, entries: [{ id, kind,
   content, createdAt }], truncated: boolean }`. Order by `id`; cap at the
   last 500 entries (`truncated` flags an elided prefix).
2. `GET /api/threads/:threadId/thinking` — bootstrap for mid-run joiners:
   `running` runs for the thread (queued runs have not published
   `stream.start` yet and have no bubble) →
   `{ runs: [{ runId, agentId, rootMessageId, startedAt, entries: last 50,
   lastChunkId }] }`. `rootMessageId` is read straight from the persisted
   `Run.replyRootMessageId` — never re-derived in the API.
   Chunk ids are BigInt — serialize as strings at the API boundary (same
   rule as `Attachment.sizeBytes`), and stringify before `publishSse`
   payloads too (BigInt breaks `JSON.stringify`).

### B5. Admin — state (`admin/src/facades/threads/hooks.ts`)

- `pendingMessages` entries gain `rootMessageId: string | null` (from
  `stream.start`), `thinking: Array<{ id?: string; kind: 'reasoning' | 'tool';
  content: string }>`, `seededFromBootstrap?: boolean`.
- Handle `'stream.thinking.tool'`; `stream.reasoning` appends to `thinking`
  (keep `reasoningContent` for compatibility or fold it in — implementer's
  choice, no dead fields left behind).
- Dedupe by `chunkId` when merging bootstrap/fetch data with live events.
- On mount and on SSE reconnect, fetch the bootstrap endpoint and seed/
  reconcile `pendingMessages` (also clears zombies: drop local runs the
  bootstrap no longer reports). Two race guards: a run whose `stream.start`
  arrived after the bootstrap request was sent is never dropped by the stale
  response, and a run whose `stream.done` this session has seen is never
  re-seeded by a response captured while it was still live (run ids are never
  reused, so "finished" is final).

### B6. Admin — UI

New `ThinkingBubble` (`admin/src/components/features/channels/ThinkingBubble.tsx`):

- Full-width, `rounded-xl border border-dashed border-[color:var(--sep)]
  bg-[var(--overlay-weak)]` (precedent: `AgentThoughtStream`,
  `.admin-deleted-bubble`), `ChannelAgentGlyph` + agent name +
  `.thinking-dots`.
- Ticker viewport: fixed height ≈ 2 lines (`text-xs text-[color:var(--tx3)]`),
  `overflow-hidden`, renders the tail of the merged thinking feed; new lines
  push old up (CSS transform transition; top fade mask). Tool lines render
  with a subtle prefix glyph (e.g. `⚙`) — styling only, no semantics.
- Compact variant (single line) for under-root rendering in the main feed.
- `onClick` → `ThoughtProcessDialog`.
- All colors via tokens; every theme works.

`ThoughtProcessDialog` (new, sibling of the channel dialogs):

- Centered modal following `DeepWaterResearchLauncherDialog` +
  `useModalA11y` (scrim `bg-[var(--scrim-strong)]`, panel `max-w-3xl`).
- Content: full merged thinking feed (fetch full log if
  `seededFromBootstrap`, else local state), interleaved reasoning paragraphs
  + tool lines, auto-scroll pinned to bottom while streaming, agent header,
  run status footer. Stays open on `stream.done` showing the final log with a
  "reply posted" note; closes on Esc/backdrop.

Placement (`ChannelMessageFeed.tsx` + `ThreadReplyPanel.tsx` + `ChannelsPage.tsx`):

- Feed items with `rootMessageId == null` → full bubble at the bottom of the
  main feed (insertion point `ChannelMessageFeed.tsx:364-365`), above the
  existing streaming-text rows' position; existing pending text rows are
  unchanged.
- `rootMessageId != null` → compact bubble rendered directly under that root
  message's row in the main feed (next to the reply-summary bar), and the
  full bubble at the bottom of the reply list in `ThreadReplyPanel` when the
  panel is open on that root (replace the `pendingMessages={[]}` at
  `ThreadReplyPanel.tsx:269` with anchored filtering passed down from
  `ChannelsPage`).
- Keep the bubble's growth pinned to the bottom. (Superseded: the per-render
  `useLayoutEffect` scroll-pin these panels used has been replaced by the shared
  `useStickToBottom` hook — `admin/src/hooks/useStickToBottom.ts` — which
  observes the feed's content and re-pins on any height change, so a growing
  ticker needs no dependency list at all.)
- The DM agent drawer (`ChannelAgentInfoDrawer`) reuses the feed and gets the
  top-level bubble for free; verify it renders.

### B7. mock-llm + tests

- `MockTurnSchema`: optional `reasoning?: string`; `streamCompletion` emits
  `delta.reasoning_content` chunks (chunked by `chunkSize`) before content
  chunks. New scenario `reasoning-tool-answer.json`: turn 1 = reasoning +
  tool call, turn 2 = reasoning + final text.
- Worker tests: recorder unit tests (coalescing, tool-line flush ordering,
  close idempotency, error swallowing); smoke or a pipeline test asserting
  `run_thinking_chunks` rows (reasoning + tool kinds, ordered) and that
  `Run.replyPlacement = 'channel'` produces a top-level reply while the
  default threads.
- API tests (existing route-test pattern): auth (non-member 404), shape,
  truncation, bootstrap for active vs finished runs.
- Admin tests (`admin/test/`): ticker tail extraction + chunk merge/dedupe
  helpers as pure functions.

## Docs to update in the same change

- `CLAUDE.md` — short paragraph under the reply-threads section: placement
  judgment field + thinking bubble events/persistence/endpoints.
- `docs/shared-type-contracts-spec.md` — SSE event registry additions.
- `docs/functionality.md` — the two new thread endpoints.
- This plan moves to `docs/done/` when shipped.

## Verification gates (definition of done)

1. `pnpm --filter @nessie/worker build` (embedded worker runs from dist).
2. Root `pnpm lint` + `pnpm typecheck` + `pnpm build` green (lint-gated).
3. Worker + API + admin test suites green, including new tests.
4. Playwright (headless) against `http://localhost:5455`: channel view with a
   live thinking bubble (mock-llm-backed run), thread panel bubble, popup
   open with streamed content — screenshots reviewed.
5. Migration lint (`pnpm lint:migrations`) green.

## Explicitly out of scope

- Rendering historical thought logs on finished messages (the API supports
  it; UI affordance can come later).
- Retention/pruning for `thread_stream_events` (pre-existing) and
  `run_thinking_chunks` (cascade-on-run-delete only for now).
- Native/mobile surfaces; the voice companion.
- Any change to DeepWater/product-handoff or external-agent message flows.
