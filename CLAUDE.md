# Nessie

Multi-tenant, self-hosted agentic work platform. Organisations host their own Nessie instance; users collaborate in a hierarchy of Organisation → Project → Team → Channel, with RBAC, approval gates, an audit trail, a token-cost ledger, MCP connector management, triggers/scheduling, video calling, and human work distribution.

> **Rule zero — a capability is not done until a person can reach it.**
> Authoritative version, with the four checks and the history behind each:
> `AGENTS.md` → "Rule zero". Read that first.

> **Voice:** Voice is a secondary, nice-to-have control surface — used mainly from the companion mobile app to issue commands — not the primary interface. The primary interface is the admin web UI (`admin/`). A voice companion (OpenAI Realtime API, `gpt-4o-realtime-preview`) exists in `macos/` but is optional and architecturally separate from the main control plane.

@./AGENTS.md

`AGENTS.md` above is the authoritative standards file — workflow, testing,
security/tenancy invariants, and the per-subsystem rules all live there. This
file adds the project map and operational facts not restated there; where a
section below points into `AGENTS.md`, that pointer is the rule.

## Architecture

- **API** (`api/`, port 5454) — multi-tenant REST control plane: auth (OIDC/session), channels, tasks, approvals, triggers, MCP connector management, token ledger, audit log
- **Worker** (`worker/`) — async execution service: agentic loop, task scheduling, trigger delivery, mailbox processing
- **Admin** (`admin/`, port 5455) — full product interface for operators and knowledge workers
- **Desktop** (`desktop/`) — Tauri shell for the hosted admin. Developer ID releases include the local executor; the sandboxed Mac App Store/TestFlight variant deliberately does not. Do not build, install, or present an ad-hoc-signed macOS bundle unless Ondrej explicitly requests one. Executor verification requires a `Developer ID Application` signature with the configured `NESSIE_DESKTOP_SIGNING_TEAM_ID`, validated with `codesign --verify --deep --strict` before installation; if that identity or its private key is unavailable, preserve the installed app and report the signing blocker.
- **Web** (`web/`) — public landing page only
- **Packages** (`packages/`) — shared runtime, scheduling, policy, and type libraries
- **Guardrails** ([docs/architecture.md](docs/architecture.md)) — things to avoid when creating files, organizing code, sharing logic, and preserving security/testability boundaries

## UOA identity and organisation structure — no local duplicates

Where UOA SSO is configured, UOA is the sole authority for identity, profiles,
and organisation/team membership, and its hierarchy maps **1:1** into Nessie
(`Organization.externalOrgId`, unique; one UOA workspace = one `Team`). No
second local copy of identity or org structure may exist. Full rule:
`AGENTS.md` → "UOA owns the org structure"; model and migration:
[docs/plans/2026-08-15-uoa-org-tenancy.md](docs/plans/2026-08-15-uoa-org-tenancy.md);
the invariant itself: [docs/brief.md](docs/brief.md) → "Current SSO identity
invariant".

## Agent voice and reactions

Agents answer at colleague length by default. The base system prompt
(`worker/src/run/execute/prompt.ts` `buildModelPrompt`) gives that a *shape*
rather than an adjective — lead with the answer, one short paragraph of plain
prose, no headers/tables/bullets unless the content genuinely is a list, go
long only when asked or when the content is irreducibly large, and on a
scheduled run report by exception. "Concise" alone had been in there for a
while and did not work: a routine hardware sweep still came back as ~400 words
with a table. This is prompt guidance and never an output cap — depth has to
stay one request away.

Agents react rather than reply when a message needs registering but no answer.
Two paths, both producing real `MessageReaction` rows (an emoji typed into a
reply is still a message):

- **Before a run** — the engagement decision can return
  `{"action":"acknowledge", emoji}` instead of `{"action":"reply"}`, spending
  no run at all. Use for a thank-you, an FYI, a decision already made:
  anything where a prose reply would carry no information the person does not
  already have (`packages/runtime/src/orchestrator.ts`, applied in
  `worker/src/run/orchestrate.ts`).
- **During a run** — the `react` builtin adds or removes the agent's own
  reaction on any message its run can already see, the same buttons a person
  clicks (`worker/src/run/pa-tools/agent-messages.ts` `runReactTool`).

A run also paints 👀 on the message it is working from
(`worker/src/run/execute/working-marker.ts`), so a person scrolling back can
see which message an agent picked up — the thinking bubble only shows in the
composer, and only while somebody is watching. The run owns that marker, not
the model: removal is fused to the terminal status transition in
`lifecycle.ts` `updateRunStatus`, so completion, failure, budget stop and
cancellation all clear it without having to remember, and a crashed run clears
it when the queue re-delivers it to a terminal state.

## Disclosure boundaries — what an agent read decides who may read its answer

Provenance, not redaction: every read that enters a run's context feeds the
`ConsumedSourceSink` in the same change. The rule and its corollaries (empty
basis fails open, shared `scopeForVisibility`, channel scopes only for
non-public channels, search fails closed, every read path asks one predicate,
live lanes cut by `runReplyIsRestricted`, containment = memory recall only):
`AGENTS.md` → "A read that enters a run's context feeds the disclosure sink".
Facts not restated there:

- The remainder after `computeReplyBasis` is stamped as `MessageBasisScope` +
  `RunBasisScope` in the same transaction as the message; `agent-message.ts`
  opens that transaction itself rather than trusting callers.
- Basis vocabulary is `user | channel | team | project | organization | agent`.
  `agent:<id>` means exactly the people who pass the shared live agent-visibility
  predicate. A destination implies agents bound to its channel; those ids are
  loaded once into the run context so `runReplyIsRestricted` stays synchronous
  on every streamed delta. Tool-posted messages resolve the bindings of their
  own target channel instead.
- Sink writers today: the transcript window (transitive), memory recall, every
  knowledge-base read, the conversation searches, attachment reads, and an
  admitted checkpoint — and a checkpoint on resume is a read path too.
- A withheld row carries no metadata, reactions, or reply participants; the
  share affordance goes only to a reader who satisfies the basis directly,
  never a grant recipient. The WS/SSE terminal events carry `restricted: true`
  instead of a preview.
- Spec and build status:
  [docs/plans/2026-08-11-disclosure-boundaries-build.md](docs/plans/2026-08-11-disclosure-boundaries-build.md).

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

## Agent documents — one shared home provisioner

Knowledge-space provisioning lives in `@nessie/knowledge`:
`packages/knowledge/src/provisioning.ts` owns `ensureMyDocsSpace`,
`ensureProjectDocumentsSpace`, `ensureTaskFolder`, and the advisory-locked
`ensureAgentDocsSpace`; `api/src/services/knowledge-provisioning.ts` is only a
thin re-export for established API callers. At inference-run setup, a
non-system agent with an assembled KB write tool lazily gets its private
`<Agent> — Documents` home (or reuses it); a spawned child uses its parent's
home, and the Personal Assistant has none because its documents belong in the
person's My Docs. When `kb_list`, `kb_search`, `kb_document_compose`, and
`kb_document_edit` are all actually available, the structural system-prompt
block injects that home id and title so the model never invents a `spaceId`.

## Agent chat cards — one card system, not an eighth look-alike

Every agent that can talk can post an **interactive card** into a conversation
with `card_post`: a ticket or email overview, an image with a caption, a small
form. Buttons along the bottom; a person presses one; the card freezes into a
terminal state retained in the chat **and** in the agent's context. Default-on
for every agent (`safe: false`, no `personalAssistantOnly`, no
`requiresExplicitGrant`) — a card is a better-shaped message, not a wider
permission, and what a card *does* is still gated at the tool called
afterwards. Spec:
[docs/plans/2026-09-01-agent-chat-cards.md](docs/plans/2026-09-01-agent-chat-cards.md).

- **One authority, one pointer.** `AgentCard` is the row; the assistant message
  carries only `metadata.agentCard = {cardId, schemaVersion}` — the
  `appSetupCard`/`todoRef` discipline, because a press must be claimed by a
  conditional UPDATE (`status = 'open'` in the WHERE), not a JSON mutation, and
  "may this viewer press" is a per-viewer server decision. Every transition —
  press, expiry sweep, run-cancel — is that same claim, so two presses or a
  press racing the sweep have exactly one winner.
- **A closed block vocabulary, never a kind per integration.** `AgentCardSpec`
  = `blocks` (`text`, `fields`, `image`, `link`, `input`, `secret`) + up to four
  `actions`. A ticket, an email overview and a form are arrangements of the
  same parts under `AgentCardMessage`/`AgentCardBlocks`. A `kind:
  'linear_ticket'` is a renderer in waiting and the eighth look-alike Rule zero
  names. An `image` is an attachment id the run can already reach, never a URL.
- **The press is a message.** It writes a real `user` turn stamped
  `metadata.agentCardResponse`, so the outcome is in the chat, is an ordinary
  human turn in the transcript, and wakes the card's agent through one
  *structural* orchestrator path (a server-written metadata key — never content
  matching). A resolved card also renders a state note beside its message
  content in every later window (`message-cards.ts`, joined by
  `withMessageNotes` exactly where the attachment inventory line goes), so
  nothing ever rewrites a message.
- **Waiting is the approval machinery, reused.** `wait: true` exits the loop
  through `pendingInput` (decided *after* dispatch — the card must exist first),
  checkpoints, and parks the run in `waiting_input`: non-terminal, holding the
  `(agent, thread)` slot exactly like `waiting_approval`. A distinct status
  because that label is user-visible in four admin surfaces and "waiting for
  approval" is the wrong words for a form. Suspend and resume are **one shared
  core each** (`run-suspend.ts`, `run-resume-core.ts`), with the approval paths
  migrated onto them — never a second copy of the claim-once discipline.
- **A secret field's value reaches the credential store and nothing else.** It
  goes through the same `storeInstanceSecret` seam and the same authorization
  as `POST /api/mcp/instances/:id/secret`, inside the press transaction, and is
  absent from the row, the message, the audit metadata (key names only), the
  realtime payload, the presenter and the model. Only
  `secretOutcomes[key] = {kind, instanceId, placement}` is kept.
- **The service mark is server-resolved.** The agent names a slug; the
  presenter matches it against the app catalogue under the viewer's own store
  floor and returns the cached `/api/apps/:id/icon` path, else null and
  initials. The model never supplies an icon URL. Rendered by `AppIcon`
  `size="badge"` — not a second icon component.
- **Who may press is the agent's call per card**: `requester` (the default when
  a person asked for the run), `thread`, or named `userIds` — refused at post
  time if they cannot see the channel. Named respondents get the ordinary
  mention bell and push through the shared alert core, which now takes an
  explicit recipient list rather than parsing an `@` out of prose.
- Expiry is agent-set, none by default, swept beside `sweepExpiredApprovals`;
  no message is posted for one.

## A recurring watch keeps one rolling status message

A sweep that finds nothing does not add a message. It edits the watch's own
status line in place — the model's latest words, plus a `checked 54× · last
09:12` counter rendered from `metadata.watchStatus` — so ninety-six quiet
sweeps a day stay one line instead of ninety-six messages burying the findings
the channel exists for.

Mechanics (`worker/src/run/execute/watch-status.ts` +
`watch-status-gate.ts`, folded in `completion.ts`):

- **The model always writes text.** Only the *routing* changes. Nothing here
  offers the model an "output is optional" affordance — that shape is what
  made every trigger run fail when `conclude_silently` shipped.
- **Two gates, structural first.** Only an unattended run belonging to an
  `interval`/`scheduled` trigger that has not set `config.rollingStatus:false`
  is eligible; then one small utility-model call judges the text as a finding
  or a no-change. That judgement **fails open** — any error, timeout or
  unparseable answer posts normally, because a missed finding is far worse
  than one redundant message.
- **The roll resets when anything else is said.** The fold only continues while
  the status line is still the newest visible message in the thread; a human
  post, another agent, or the watch's own finding starts a fresh line at 1.
  Purely structural (authorship + recency), never a reading of content.
- **Race-safe.** Find-newest → check-superseded → update-or-create runs inside
  one transaction under `pg_advisory_xact_lock(threadId, agentId)`, so two
  sweeps cannot both create a status row or both increment from the same count.
- **Quiet by construction.** An edit adds no row, so unread counts
  (`created_at > last_read_at`) do not move and `createMessageMentionAlerts`
  never runs. Realtime uses a `message.updated` event that refreshes only the
  open thread — deliberately not `['channels']`, so badges stay put.

## A schedule that stops says so

The transition owns the alert — failure classification into a remedy-naming
state, exactly-once alerting per transition, explicit recovery (never
auto-heal at login), epoch-only re-stamp, re-arm from now: `AGENTS.md` → "A
capability that can stop working owns the way a person finds out". Facts not
restated there:

- `TriggerLaunchOriginError` carries a reason code
  (`worker/src/control/trigger-origin.ts`): unprovable identity →
  `needs_reauthorization` (a button); everything else (target, membership,
  malformed origin) stays `error` (an edit). `health_reason` / `health_detail`
  persist the cause so the page can explain without parsing a message string.
- The transition is claimed by a single conditional UPDATE whose WHERE clause
  carries the decision — `dispatchEventTriggers` fans out with no claim on the
  trigger, so a read-then-write would have raced. `trigger.health-alert`
  writes a durable `UserAlert` for the organisation's active **owners** — the
  set who can both reach the owner-gated Triggers page and repair the schedule
  — and pushes under its own `pushTriggerHealth` preference with a generic
  body (the cause stays behind the deep link, so a lock-screen notification
  cannot carry a provider error). The alert is revalidated on read
  (`visibleUserAlertWhere`), so it stops surfacing once the trigger is healthy.
- `POST /api/triggers/:id/reauthorize` refuses and names a changed workspace;
  an owner taking over somebody else's schedule is a separate explicit act. It
  is the only recovery path: editing preserves the server-owned identity by
  design, resuming without repair re-arms into the same failure, and deletion
  is refused once any delivery exists.
- **Nothing about a trigger's provenance leaves the server.** The record
  presenter strips `launchOrigin` / `createdByUserId` / `createdViaTool`, the
  webhook intake key is opt-in per audience (`TRIGGER_ADMIN_AUDIENCE`) so a
  call site that does not consider audience omits it, and caller-supplied
  dedupe keys are namespaced by the route's own server-decided source — the
  scheduler's keys are predictable, and a caller could otherwise pre-create a
  delivery and silently cancel a future occurrence.

## Message reply threads (#233)

`Thread` is a conversation *container* (channel → named threads); Slack-style *reply threads* live one level deep on messages: `Message.rootMessageId` (nullable self-FK; replies to replies attach to the same root), with materialized per-root `replyCount`/`lastReplyAt`/`replyParticipantIds` updated atomically via `@nessie/runtime` `applyReplyBookkeeping` in the message-create transaction, and `MessageThreadFollow` per (user, root) with auto-follow on participate (author the root, reply, or be mentioned in a reply) plus explicit unfollow. Reply visibility inherits the container; deleted roots tombstone and keep their replies; "Also send to #channel" posts an inline top-level copy carrying `metadata.replyBroadcast.rootMessageId`. Message-create accepts `rootMessageId` (validated same-container top-level root); list defaults to top-level posts and takes `?rootMessageId=` for paginated replies; realtime adds `message.reply` + `message.reply.meta`. A run triggered by a message replies **into that message's reply thread** by default (root = `triggerMessage.rootMessageId ?? triggerMessage.id`), and thread-following scopes to that reply thread; DeepWater/product-handoff and external-agent paths stay top-level and byte-identical. **Where a run replies and what it reads are separate questions** (`resolveReplyRootMessageId` vs `resolveConversationRootMessageId`): the conversation window narrows to a reply thread only when the trigger message is *itself* a reply. A run answering a top-level message is starting a reply thread, not sitting in one, so it reads the channel thread — scoping it to its own trigger would leave it a one-message window with no history. Admin: reply-summary bar under roots, deep-linkable right-hand thread panel (`/channels/:id/threads/:threadId/replies/:rootId`, pushes ≥1280px, overlay 900–1279px, full-screen <900px, drag-resized width persisted), `T` opens the focused message's thread. The
panel **leaves before the route does**: `closeThread` sets `isClosing` and holds the navigation for `THREAD_PANEL_CLOSE_MS`, since its queries are keyed on the open root and navigating first would blank it mid-animation. What animates is the *footprint*, not the width — a negative `margin-inline-end` hands the space back to the conversation column while the panel rides out on a `translateX`; animating width would rewrap the thread every frame. Tapping back into the conversation closes it (the desktop equivalent of the 900–1279px scrim) via one `onClickCapture` on the surface: capture phase, so a reply control inside the column runs afterwards and `openThread` cancels the close that click started rather than racing it. A click ending a text selection is ignored. Reply-unread counters (#212) and the Threads inbox (#213) build on `MessageThreadFollow`.

**Reply placement + thinking bubbles** ([docs/plans/2026-08-05-agent-thinking-bubbles-and-reply-routing.md](docs/plans/2026-08-05-agent-thinking-bubbles-and-reply-routing.md)): where a run's reply lands is decided **before** the run starts — engagement decisions carry a model-judged `replyPlacement` (`thread` = answer owed to the asker's exchange; `channel` = standalone message to the room; @mentions and PA DMs stamp `thread` structurally, never by content heuristics) persisted on `Run.replyPlacement`; `resolveReplyRootMessageId` (`worker/src/run/execute/reply-placement.ts`) applies it after the DeepWater-handoff/external-agent/PA-delegation carve-outs and persists the resolved anchor on `Run.replyRootMessageId`. While a run thinks, a per-run `ThinkingRecorder` coalesces visible reasoning deltas (2 KiB/250 ms) plus tool-activity lines into durable `run_thinking_chunks` rows, each also published on the thread SSE stream with its chunk id (`stream.reasoning` / `stream.thinking.tool`; `stream.start` now carries the reply anchor, and `stream.done` is always published last). The admin renders a dashed, full-width **thinking bubble** with a 1–2-line live thought ticker wherever the reply will land — bottom of the channel feed for top-level replies; compact under the root row plus full bubble in the thread panel for threaded ones (reply text streams only where the reply will land) — and clicking it opens a centered thought-process dialog that streams live and merges the durable log for mid-run joiners (`GET /api/threads/:id/thinking` bootstrap, `GET /api/threads/:id/runs/:runId/thinking` full log, both thread-visibility-gated; `stream.*` stays excluded from SSE backlog replay).

**Liveness (client only, no server events).** The thread SSE reconnect policy lives in `admin/src/facades/threads/stream-retry.ts`: only **403/404** end the loop (the viewer cannot see this thread); every other outcome — 401 mid token rotation, any 5xx, a bodyless 200, a network error — reconnects with equal-jitter exponential backoff (1 s base, 30 s cap) that resets on each established connection. It used to `break` on any non-OK response, which killed bubbles and streaming text for the rest of the component's mount while replies kept arriving over the WebSocket refetch path. Because `stream.start` only fires after queue pickup, the engagement-decision call, a second queue hop, run claim, toolset assembly and memory retrieval, the admin also shows one **anonymous ambient line** — three muted `.liveness-dots`, no name, no avatar (`liveness-hint.ts` + `useAgentLivenessHint.ts`, `ChannelMessageFeed` `showLivenessHint`) — from the moment the viewer posts into a surface that structurally has an agent (bound agent, PA DM, or external-agent DM). It never names an actor because the engagement decision is model-judged and may decline, and it clears on the first of: a pending stream entry for that surface (the bubble *is* the indicator, so the two are never painted together — visibility is derived during render, not cleared in an effect), a message from anyone but the viewer, an agent reaction (`acknowledge`), or 10 s. Idle renders nothing; the channel feed and the reply panel share the one hook and the one feed component.

Legacy single-user server lives in `src/` and is being removed — do not rely on it for new work.

## File storage & accounting — single chokepoint

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
  [docs/knowledge-base-requirements.md](docs/knowledge-base-requirements.md).
- Specs:
  [docs/plans/2026-08-06-attachment-thumbnails-and-previews.md](docs/plans/2026-08-06-attachment-thumbnails-and-previews.md),
  [docs/plans/2026-08-07-images-in-agent-context.md](docs/plans/2026-08-07-images-in-agent-context.md).

## Embeddings — routed separately, one pinned width

Authoritative: `AGENTS.md` → "Embeddings" (`NESSIE_EMBEDDING_*` routing with
chat-provider inheritance, `EMBEDDING_DIMENSIONS` as the single source of the
vector width, `ModelClient.embeddingModel` as the vector's model identity).
Additional facts: a width-change migration drops the HNSW index, nulls the
vectors, `ALTER COLUMN`s, and recreates the index (see
`20260811120000_embeddings_1024_dimensions`); the `match_thoughts_*` functions
need no change — PostgreSQL discards the typmod on function parameters.
Details: [docs/deployment.md](docs/deployment.md) "Embedding model and vector
width".

## Web Push (browser notifications)

- Browser Web Push is a second push transport alongside native APNs/FCM: the worker's `handlePushDispatch` also fans messages out to users' `WebPushSubscription` rows. Crypto is in-process (`packages/push`, RFC 8291 + RFC 8292 VAPID, no third-party deps).
- One VAPID key pair per instance via `NESSIE_WEBPUSH_PUBLIC_KEY`, `NESSIE_WEBPUSH_PRIVATE_KEY`, `NESSIE_WEBPUSH_SUBJECT` (all three required to enable). Generate with `node scripts/generate-vapid-keys.mjs`. Public key is safe to expose; private key is secret.
- Admin SPA service worker (`admin/public/sw.js`) + manifest + a "Browser notifications" toggle on `/settings/notifications`; API endpoints under `/api/push/web/*`. Requires HTTPS (localhost exempt); iOS needs an installed PWA (16.4+).
- **Authoritative guide: [docs/web-push.md](docs/web-push.md).**
- User alerts: direct @mentions write durable per-recipient `UserAlert` rows in the message-create transaction (self skipped, broadcast none, agent-authored identical; mute suppresses push, never the row) and surface via `GET /api/alerts` + `POST /api/alerts/read`, realtime `alert.created`/`alert.read`, the admin top-bar bell, and mention-framed push (`<author> mentioned you in <channel>`). `workspace_invitation` alerts are reconciled from every verified UOA `/org/me` read, follow the user's current local organisation for bell visibility, and are deleted—not read-marked—when UOA no longer returns the invite or acceptance succeeds.

## Tech

- Node/TypeScript (strict mode), Fastify, Prisma + PostgreSQL
- Multi-tenancy: Organisation → Project → Team → Channel schema with `organization_id` scoping on all child tables
- RBAC policy engine with deny-overrides; OIDC SSO with PKCE
- Agentic loop — run budgets (2026-08-05 redesign,
  `docs/plans/2026-08-05-run-budgets-context-and-research-routing.md`):
  `Agent.effort` maps **only** to provider `reasoning_effort`; it no longer
  implies spend caps. Per-dimension budget = `Agent.runLimits` (optional
  explicit caps, Agent Designer "Run limits") `??` the deployment backstop
  (`NESSIE_RUN_BACKSTOP_MAX_{TOKENS,TOOL_CALLS,ITERATIONS,WALLCLOCK_MS,COST_CENTS}`,
  defaults 500k / 2000 / 1000 / 45 min / 2000¢ — a safety envelope, not a user
  budget; resolution in `worker/src/run/run-budget.ts`). At 80% of any cap an
  interactive, non-handoff run is **wound down first**: a one-time injected
  instruction tells the model to finish and hand over with what it has inside
  the remaining slice (new delegate fan-out refused structurally); a delivered
  handover completes with the model's words as the notice plus a quiet
  `wound_down` checkpoint (spec §3a). Only when the model overruns that does
  the loop stop at ~90% with reserved headroom, write a durable `RunCheckpoint`
  (work-state note + verbatim sources, `run.checkpointed` `TaskEvent`), and
  deliver partial text + a classified notice (`iteration_limit` /
  `tool_call_limit` / `time_limit` / `token_limit` / `cost_limit` /
  `repeated_tool_calls` / `org_budget_blocked`,
  `worker/src/run/execute/budget-stop.ts`; member-visible copy carries **no
  currency figures**). The token dimension meters **effective** tokens —
  `input + output + round(weight × cacheRead)` per invocation, degrading to
  `totalTokens` when a provider reports no split — because cache reads are
  re-served context priced at a fraction of fresh input; metering them flat
  killed a run at a claimed 504,738 tokens whose true spend was ~37% of that.
  The weight is a price ratio resolved once per run from the org's
  `ModelPricingProfile` (`cacheReadPerMillion / inputPerMillion`, clamped to
  [0,1]), else `NESSIE_CACHE_READ_WEIGHT` (default 0.25); resolution is
  best-effort and never fails a run. A **pre-flight gate** also refuses to
  dispatch a call whose estimated context would carry the run past the full
  (100%) token limit, so a run can no longer overshoot by a whole context.
  `run.budget_exhausted` reports the effective `tokensUsed` plus
  `rawTokensUsed` + `cacheReadTokens`. The org `Budget` verdict is re-checked mid-run between
  iterations (≥30 s apart, same human-interactive exemption as the pre-run
  gate). Any follow-up run in the same thread/reply-thread auto-loads and
  claims the newest unconsumed checkpoint (set-once conditional update) and
  injects it as explicitly untrusted working notes — so a plain "keep going"
  reply resumes instead of re-doing the work; the stop notice's
  `metadata.runStop = { runId, stopReason, checkpointId?, continuable }`
  additionally drives a one-tap admin Continue. Non-interactive runs
  (triggers/schedules/workflows; `payload.interactive !== true`) never ask:
  the worker auto-continues up to `NESSIE_RUN_AUTO_CONTINUATIONS` (default 2)
  generations (`run.continued` `TaskEvent`, `Run.continuationOfRunId`
  lineage), yielding to the per-(agent, thread) run slot when busy. Context is
  managed per-model (`worker/src/run/context-window.ts`, conservative 100k
  default): at ~80% of the window the elder transcript folds into a rolling
  work-state note via real compaction (`worker/src/run/context-compaction.ts`,
  verbatim-URL sources, closed tool groups only, cooldown + bounded attempts,
  invocations counted in run totals); silent trimming is emergency-fallback
  only. `delegate` sub-agents run a fixed small budget, are capped per run by
  `NESSIE_MAX_DELEGATES_PER_RUN` (default 16), and — like compaction — use
  `NESSIE_UTILITY_MODEL` when it resolves through the run's own org provider
  (else the run's model). A structural research-routing prompt block (from
  toolset facts only, never message content) steers granted agents to offer
  DeepWater for deep research and ungranted agents to research via
  `web_search` + delegate digests; DeepWater launch turns get no routing block
  and no checkpoint injection. All tool results (builtin, MCP, `delegate`) are
  truncated **middle-out** at the single loop chokepoint before entering
  context (head ~70% / tail ~30%, joined by
  `\n\n[... truncated N chars ...]\n\n`, idempotent so a per-tool cap applied
  earlier passes through unchanged). Per-tool caps keep discovery tools within
  one order of magnitude of each other: 4,000 chars for `web_search` /
  `web_fetch` / `document_read`, 12,000 for raw `http_fetch` bodies, 32,000 as
  the chokepoint ceiling (`worker/src/run/tool-util.ts`). MCP tool descriptors
  are name-sorted and their exposed names allocated in a fixed order, so the
  model's tool array is byte-identical across iterations and the provider's
  prompt-cache prefix survives. Allowed builtin sets above
  `NESSIE_BUILTIN_INLINE_TOOL_LIMIT` (default 20) keep a fixed hot set inline,
  expose curated stubs for the rest, and return exact schemas through the
  non-mutating `tool_spec` meta tool; smaller sets remain fully inline. Every run
  also records a wall-clock-only stage-latency breakdown at its terminal state
  (completion **and** failure) as a `run.timing` `TaskEvent` — `{ outcome,
  runId, queueWaitMs, totalMs, inferenceMs, inferenceCount, toolMs,
  toolCount }`, no cost data (`worker/src/run/execute/run-timing.ts`) — so a
  slow run is diagnosable; owners read recent summaries at
  `GET /api/ledger/runs/timing`.
- **Budget threshold alerts + failed-run attribution** (local ops only, never
  UOA credits). The gate no longer only observes usage passively: `evaluateBudget`
  (`packages/runtime/src/budget.ts`) returns the byte-identical verdict PLUS an
  alert snapshot, and `applyBudgetGate` fires **at most once per budget scope per
  period** when cumulative spend first crosses `Budget.warnThresholdPercent`
  ('threshold') or first blocks a run ('blocked'). Alerting runs AFTER the verdict
  is applied and swallows its own errors, so blocking behaviour is unchanged.
  Durable crash-safe dedupe = a `budget_alerts` marker row unique on
  `(scopeType, scopeId, periodStart, kind)`; each alert also emits a
  `budget.threshold_alert` `TaskEvent` (queryable) and enqueues
  `budget.alert-dispatch`, which notifies org owners + the scope's managers
  through the shared push pipeline (`worker/src/control/push-delivery-core.ts`,
  reused by message push + budget alerts), respecting push preferences,
  deep-linking `/ops/usage`. Every terminal run persists its inference spend:
  completion and the budget-stop no-text path already did; the generic
  failure/crash path now does too via a caller-owned invocation accumulator
  threaded through `runAgenticLoop`, so a failed run's tokens stay attributable
  (buzz #1659, idempotent on `inferenceInvocationId`). Owners read spend split by
  run outcome (completed/failed/cancelled/…) at `GET /api/ledger/tokens/by-outcome`.
- Active run lifecycle controls (`api/src/routes/runs.ts` +
  `api/src/services/runs.ts`; buzz #2453/#1593, epic #141): org-scoped
  `GET /api/runs/active` lists live runs (+ recently-ended restartable runs);
  `POST /api/runs/:id/cancel` cancels — a queued/approval-suspended run flips
  straight to `cancelled` (never executes; the worker's terminal guard skips
  it), a running run gets a cooperative `cancelRequestedAt` flag the agentic
  loop polls between iterations and tool-call batches, exiting via the
  classified-stop machinery (`worker/src/run/execute/cancel-stop.ts`, mirroring
  budget-stop: partial text delivered + a "cancelled" notice, run `cancelled`,
  `run.cancelled` `TaskEvent`). `POST /api/runs/:id/restart` re-runs a terminal
  `failed`/`cancelled` run, enqueuing a fresh run that replays the same trigger
  message and thread and links back via `Run.restartOfRunId`.
  `POST /api/runs/:id/continue` (`api/src/services/run-continuation.ts`)
  resumes a terminal run from its unconsumed `RunCheckpoint`: same channel
  access that could have triggered the run, one transaction claiming the
  checkpoint (set-once `consumedByRunId`) + creating the continuation run
  (`Run.continuationOfRunId`) + task + enqueue; 409s: `RUN_BUSY`,
  `RUN_CHECKPOINT_CONSUMED`, `RUN_NOT_CONTINUABLE`. A run whose
  trigger message carries `integrationLaunch` metadata (DeepWater handoff) is
  rejected from cancel/restart/continue with `409 RUN_HANDOFF_MANAGED` → use
  `research_cancel`; the
  handoff invariants are never touched. `Run.triggerMessageId` (populated by the
  chat orchestrator + integration handoffs) backs both the guard and the replay.
  Admin cancel is surfaced on the live document-stream dialog
  (`useCancelRun`) and Continue on budget-stop notices
  (`admin/src/components/features/channels/RunStopContinue.tsx`, `useContinueRun`);
  the standalone Agents → Activity page and its `RunLifecyclePanel` were removed,
  so the org-wide active-run list and the restart control have no admin surface
  (the `GET /api/runs/active` and `POST /api/runs/:id/restart` endpoints remain,
  API-only).
- MCP connector management (REST, not JSON-RPC): `api/src/routes/mcp.ts`
- MDNS/Bonjour — backend advertises `_nessie._tcp` for local network discovery

## Git — worktrees mandatory

Authoritative workflow (worktrees under `.worktrees/`, main checkout stays on
`main`, merge in the same turn after review/lint/tests, commit and push every
turn): `AGENTS.md` → "Workflow". After a merge, in the main checkout run
`git switch main && git pull --ff-only`, remove the worktree
(`git worktree remove …`), and delete the merged branch.

## Dev mode (hot reload)

- `pnpm dev` (repo root) = `turbo run dev --parallel`: API (5454, nodemon) +
  admin (5455, Vite HMR). Polling watchers are mandatory and must stay — see
  `AGENTS.md` → "Workflow" for why (fsevents is dead on this volume).
- After starting/restarting a dev server, verify it: hit `GET /health` (5454)
  and `GET /` (5455), and confirm `@vite/client` is present in the served
  admin HTML.

## Build (production / CI)

- `pnpm --filter @nessie/admin build` produces the static admin bundle
  (`dist/`); `pnpm --filter @nessie/admin preview` serves it. Prod/CI only —
  use `pnpm dev` for the local loop.
- **Build:** Install a release on the named device.
- Worker rebuilds after worker edits, desktop/App Store builds, lint-gated
  root builds, Prisma generation ordering, migration immutability, and all
  test rules (Turbo invocation, `DATABASE_URL`, DB-suite discipline):
  `AGENTS.md` → "Workflow".

## Production deployment

- Production is **self-hosted on Hetzner** (`178.105.82.46`) as Docker
  containers, reusing the host's shared Caddy edge proxy and Docker networks
  (`edge`/`db`). It is **not** GCP Cloud Run — the old GCP workflow/spec are
  retired ([docs/phase2-gcp-deployment-spec.md](docs/phase2-gcp-deployment-spec.md)
  is historical).
- URLs: public web `https://nessie.works`, admin `https://app.nessie.works`,
  API `https://api.nessie.works`. TLS is automatic (Caddy + Let's Encrypt);
  DNS is Cloudflare, DNS-only.
- Stack: `nessie-api` + `nessie-worker` (one `Dockerfile.app` image, command
  override) + `nessie-admin` (static nginx) + a dedicated `nessie-postgres`
  (pgvector — the shared Postgres lacks the `vector` extension). No Redis (queue
  and realtime are Postgres-backed). Mode is `selfHosted`; first login is the
  one-time bootstrap owner URL.
- Compose: `infrastructure/compose/docker-compose.prod.yml`. Redeploy with
  `infrastructure/compose/redeploy.sh` after rsync'ing to `/srv/nessie`.
- The API trusts `X-Forwarded-For` only when `NESSIE_API_TRUSTED_PROXY_HOPS`
  is set. Production behind Caddy sets it to `1`; local/dev defaults to `0`
  and ignores forwarded client IP headers.
- **Authoritative guide: [docs/deployment.md](docs/deployment.md)** — first
  deploy, redeploy, config reference, MCP secret store, and SSO status.

## Linting

- **TypeScript**: strict mode (`strict: true` in tsconfig), ESLint with `max-len`, `noImplicitAny`, `noUnusedLocals`
- **Swift**: SwiftLint with strict mode, warning treated as error in CI

## Theming / design system

- The admin is fully color-themed via CSS custom properties. **All color lives in
  `admin/src/styles.css`** — the base `:root` is the default "nebula" theme, and
  each `[data-theme="<id>"]` block re-declares the same tokens. Components carry
  **no** raw hex or Tailwind named-color utilities; they reference tokens via
  `var(--x)` / `bg-[var(--x)]`.
- Switcher: `ThemeProvider` (`admin/src/providers/`) + Appearance page
  (`/settings/appearance`); choice persists in `localStorage["nessie.theme"]`
  for logged-out screens and on `User.preferences.theme` for signed-in users, so
  web, desktop, and mobile use the same account theme.
- Adding a theme = add a `[data-theme]` block (redeclare every token) + register
  the id in `ThemeProvider`. See [docs/plans/2026-06-10-design-system-theming.md](docs/plans/2026-06-10-design-system-theming.md).
- **Content system (proposal, 2026-09-01).** Tables, lists, pagination, forms,
  validation, feedback, loading/empty/error states, chips, key-value views and
  confirm flows were audited across every content page; the primitives mostly
  exist and are adopted on a minority of surfaces (`QueryState` 12 files vs ~60
  hand-rolled triads, `FormFieldError` 2 files vs ~40 error lines, 11 modal
  shells outside `Dialog`). The inventory, the proposed kit, the scale and the
  phased migration are in
  [docs/plans/2026-09-01-content-design-system/overview.md](docs/plans/2026-09-01-content-design-system/overview.md);
  navigation, page headers, buttons and chat are deliberately outside it. One
  rule from it applies now, ahead of the kit: **no nesting** — a card
  never contains a card, a table never contains a table, a bordered box never
  sits inside a bordered box. Depth is dividers and spacing, not a second
  frame. A second rule is decided ahead of the kit too: **big elements are
  one contract from the API to the pixel.** List endpoints paginate through
  `@nessie/schemas` `PaginationParamsSchema`/`PaginationMetaSchema` (cursor
  keyset, `limit` ≤ 100, `total` required on admin lists) and the admin
  consumes them through one facade and `PaginationFooter`; a route that pages,
  sorts or reports validation errors differently is refactored onto the
  contract, never accommodated by a second mode in the component.
- **One tab bar, everywhere.** Every single-select strip in the admin — detail
  tabs, page sections, and filter segments — is
  `components/primitives/TabBar.tsx`. The selected item is a *single sliding
  pill* (`.tabbar-indicator`, measured from the DOM and moved with a 120 ms
  `transform`/`width` transition) rather than a per-item background that blinks
  on and off, so a tab change reads as one object moving to what was tapped.
  `role="tablist"` when it switches panels, `role="radiogroup"` when it narrows
  a list; `fullWidth` stretches items, `size="sm"` for dense strips, `count`
  renders a dimmed `(n)`. Adding a tenth fork is the defect Rule zero names —
  parameterise this one. (2026-08-29 replaced nine forks: `.admin-tab`,
  `SegmentedControl`, `IntegrationTabs`, and six inline strips.)
- **One identity picture, one shape, one source.** Every avatar in the admin is
  `components/primitives/IdentityTile.tsx`, wrapped by the resolving primitive
  for its kind; a call site says what it depicts and never assembles a tile. Its
  radius is proportional (`identityTileRadius`) because the `--radius-*` tokens
  are re-declared on `:root`, so `rounded-md` was a flat 10px at every size — a
  96px portrait read as a square, an 18px tile a circle. An agent's picture
  resolves from its **id** through `providers/AgentIdentityProvider.tsx`, since
  `GET /api/agents` omits `systemManaged` agents — which is why the Personal
  Assistant was a portrait in the sidebar and a `⚡` in the thread panel; see
  [identity avatars](docs/plans/2026-09-02-identity-avatars.md).
- **One composer, and at rest it is one line.** Every message composer is
  `components/features/channels/ChannelComposer.tsx` (six call sites): at rest a
  single line — placeholder centred beside Send, no toolbar glyphs — opening
  while focus is inside it or anything is staged. Send is pinned to the bottom
  line and the toolbar unfolds *below* the editor, so that line never moves and
  the growth reads as expanding upward. Both states hang off
  `.admin-compose[data-expanded]` and one `--compose-line` in `styles.css`.
  Focus is tracked on the `<form>` — a toolbar button blurs the editor, and
  collapsing then would pull it out from under the click.

- **One dialog shell.** Every centred modal is
  `components/shared/Dialog.tsx`, which *always* composes `useModalA11y` (focus
  in, Tab trap, Escape, focus restore) and `useOverlayDismiss` (the drag-safe
  scrim gesture), and always emits `role="dialog" aria-modal="true"` with a
  labelled heading. It exists because the affordances had drifted apart rather
  than the markup: of 51 overlay files, ~13 composed the a11y hook and twenty-plus
  had **no** Escape, no focus trap and no dialog role at all, while half used the
  `onMouseDown` scrim pattern `useOverlayDismiss` was written to replace (a drag
  released outside the panel discarded an in-progress edit). `ConfirmDialog`
  builds on it and replaced four native `window.confirm` deletes — note that
  `window.confirm` blocks, so a converted call site must carry its own `pending`
  flag rather than relying on the thread being frozen. Edge-anchored drawers,
  the full-screen search overlay, the scroll-locking attachment viewer and the
  two dialogs that branch their scrim on phone layout are deliberately **not**
  this component; each says so where it stands.

## Ports — NON-NEGOTIABLE

- **API**: `5454` (local dev) — always. Do not kill or restart without restarting on the same port.
- **Admin**: `5455` (local dev) — always. UI verification MUST use `http://localhost:5455`.
- Never use any other port for these services in local dev.
- Moved from 5554/5555 on 2026-06-11 because an Android emulator (`gpteen_api34`) squats on 5554/5555 — see the emulator-port-conflict memory.
- **Production is unchanged:** the API container's internal port stays `5554`, pinned via `NESSIE_API_PORT` in `infrastructure/compose/docker-compose.prod.yml` (behind the shared Caddy proxy). Only local dev moved.

## Verification

Every UI/frontend change is verified with headless Playwright against
`http://localhost:5455/<path>` (screenshot the affected page, confirm correct
rendering) before the work is considered done. Full rule: `AGENTS.md` →
"Verification".

## Apps catalogue — `/apps`

Installing an integration should feel like installing an app in Slack, not like
configuring a server. `/apps` is that surface, filled from the official MCP
Registry (~5,500 apps). The invariants — second face on `McpCatalogEntry`,
store reads a decision (never re-derives from `status`), Postgres-owned
ranking with no client re-sorting, connect orchestrates the existing
`createInstance` → probe → `startOAuth` machinery (PKCE on both legs, constant
callback page, `noopener` popup), installing-is-not-granting via
`requiresExplicitToolGrant`, and the leak-proof presenter — live in
`AGENTS.md` (the two App Store bullets). Spec:
[docs/plans/2026-08-29-apps-catalogue/overview.md](docs/plans/2026-08-29-apps-catalogue/overview.md).
Facts not restated there:

- **Installed is one flat shelf; categories are a catalogue affordance.**
  `?installed=true` with no category returns a single alphabetical page spanning
  every category (`loadInstalledPage`), paged on `offset` against
  `installedCount` exactly as a category page is. It renders through the same
  `AppCategorySection` with `category: null` + `standalone` (`installedShelf`),
  so the flat list is a parameter of the shelf, never a second grid; the Featured
  strip is hidden there because, uncurated, it *is* that list. An empty grid also
  suppresses the footer nudge — the two said the same sentence with the same
  button one line apart — and `catalogueEmptyMessage` returns `actions`, so a
  search that found nothing inside Installed offers **Search all apps** (drops
  the narrowing, keeps the query) beside Add custom app.
- **Ingested rows are always `community`.** Trust decided from the advertised
  endpoint was forgeable: the record author picks that URL.
- **An app icon resolves on first view and the instance shares one copy.**
  Caching was wired only into the owner-triggered sync, so the scheduled sweep —
  the only sync that writes in production — left all 5,548 rows on a monogram.
  `resolveAppIcon` asks four sources in descending order of worth — the
  publisher's registry-declared `icons` (now captured at ingest; it used to be
  discarded), the site's own `<link rel="icon">`, conventional paths, then the
  publisher's GitHub avatar — unwrapping a PNG out of an `.ico` rather than
  rejecting it. That is 75% of rows measured, against 32% for guessed paths
  alone. It claims the attempt with
  one conditional `iconResolvedAt` UPDATE so dozens of cards fetch once and a
  site with no favicon is never re-tried unless a later registry sync supplies
  a new candidate, and **never blocks the request** — the route 404s immediately
  and the icon appears next visit. Bytes are
  origin-only-candidate, `safeFetch`-pinned, byte-capped, MIME-sniffed to raster
  (SVG dropped) and stored through `FileService`. The client reads it as an
  authed blob (`useAuthedObjectUrlFromPath`): `<img src="/api/…">` fails both on
  cross-origin (`app.` vs `api.`) and on the missing `Authorization` header.
- Service in `packages/mcp-manage/src/apps/`; seeds
  `pnpm --filter @nessie/api seed:apps` and `sync:registry`.

## MCP Integration

The live API server (`api/`) exposes a **REST MCP connector-management surface** under `/api/mcp/*`. This is for managing third-party MCP connectors (register, list, approve, activate, delete) — it is not a JSON-RPC tool server.

The management core lives in the shared **`@nessie/mcp-manage`** package (catalog, instances, probe, tool projection, credentials, OAuth, encrypted secret store, SSRF wrapper) so the API routes and the worker's personal-assistant tools share one implementation — the sharing, scope, credential-ref, locking, and context-safe-toolset rules are in `AGENTS.md` (the MCP connector management bullet). On top of it:

- **Library + discovery**: `GET /api/mcp/library` (curated well-known remote servers + live search of the official MCP registry, HTTP/SSE remotes only), `POST /api/mcp/discover` (probe a pasted link for an MCP endpoint + auth requirements), `POST /api/mcp/library/import`. The personal assistant uses these for guided setup; people add a custom app from `/apps`.
- **Personal-assistant connector tools** (PA-only builtins): `connector_list`, `connector_library_search`, `connector_discover`, `connector_install`, `connector_authorize`, `connector_test`, `connector_set_secret`, `connector_uninstall` — full conversational setup from just a service name or URL, with secrets stored encrypted (`POST /api/mcp/instances/:id/secret` is the UI equivalent).
- **Dynamic OAuth** (MCP authorization spec): `{ method: "oauth2" }` with no static client triggers metadata discovery (RFC 9728/8414), Dynamic Client Registration (RFC 7591, one public client per org × issuer in `mcp_oauth_clients`), authorization-code + PKCE S256 + RFC 8707 `resource`, pg-backed one-shot state (`mcp_oauth_states`), per-user token placement, and automatic refresh at probe/dispatch. Notion/Linear/Sentry/Atlassian/Asana are curated OAuth entries — users just sign in. Set `NESSIE_API_PUBLIC_URL` in prod so the worker can mint callback URLs.
- **Scoped sharing**: scope rules per `AGENTS.md`; members also see shared installs they can reach, and shared-scope installs keep the `pending_review` tool gate (user-scope installs auto-activate). See [docs/external-tool-integration.md](docs/external-tool-integration.md) §2.
- **Admin locking**: `/lock`, `/unlock` on a catalog entry; 🔒 pill + disabled install in the UI, clear refusal from the PA. Install-time gate only — existing instances keep working.
- **External-agent products** (e.g. DeepSignal): a first-party product surfaced as a per-user DM channel whose bound agent has `executionMode = external_mcp` — turns proxy straight to the product's MCP endpoint with **no Nessie inference**, reply + cards rendered verbatim. The identity/key/tenancy invariants (the `DEEPSIGNAL_MCP_APP_KEY` `dsk_` bearer pinned to the canonical catalog and `https://api.deepsignal.live`, delegation + signed `X-Nessie-Context` on every call, startup key-distinctness checks, team-mapping rechecks, managed-instance protections) are in `AGENTS.md`. Surface facts: the global catalog is integration-owned, absent from the generic library, and immutable through generic catalog controls; the private DM key is `extagent:deepsignal:${orgId}:${userId}:${uoaTeamId}`, so switching teams creates a distinct thread and legacy team-less channels fail closed. History hydration: `POST /api/channels/:id/external-sync` (idempotent on `metadata.external.turnId`). Insight webhook: `POST /api/integrations/deepsignal/events` (per-org HMAC secret via `PUT /api/integrations/products/:slug/webhook-secret`, stored encrypted) — **delivery-shaped, not one-card-per-event**: insights coalesce into a single rolling "You have N new signals" digest message per user, updated in place within `NESSIE_SIGNAL_DIGEST_WINDOW_MS` (default ~1h; per-insight ids retained for idempotency + counts-by-kind), and fresh proactive digests are budgeted per user per rolling window (`NESSIE_SIGNAL_BUDGET_MAX` default 6 / `NESSIE_SIGNAL_BUDGET_WINDOW_MS` default 24h — sane heuristics, not law); over budget an insight is still recorded on the digest but the channel interruption (realtime `message.new`) is suppressed. The **Signals** page (triaged Overview/Inbox): `GET /api/integrations/products/deepsignal/signals?include=active|all` + `POST …/signals/:insightId/act` (done|snooze|mute|reopen) over the user's user-scoped instance via the shared `resolveUserScopedProductTransport`/`callInstanceTool` seam, fail-closed to `{ status: 'needs_setup' }` when not linked. See [docs/plans/2026-07-09-deepsignal-integration.md](docs/plans/2026-07-09-deepsignal-integration.md), [docs/plans/2026-07-10-deep-integration-surface-registry.md](docs/plans/2026-07-10-deep-integration-surface-registry.md) + [docs/external-tool-integration.md](docs/external-tool-integration.md) §2.

- **DeepWater as an agent tool** — an owner-only `team-enablement` toggle
  provisions a **team-scoped, tool-projecting** `McpServerInstance` from the
  `deep-water` catalog entry and projects Ledger's `research_start` /
  `research_status` / `research_report` / `research_list` / `research_cancel`
  as active `mcp_research_*` tools, **always routed through Ledger**:
  `LEDGER_DEEPWATER_MCP_URL` (hosted
  `https://ledger.unlikeotherai.com/v1/mcp/deepwater`) with
  `LEDGER_PROXY_TOKEN`, Nessie's one deployment-wide, product-bound app API
  key — never a per-user credential, never a webhook signing secret. Enable
  fails loudly (`LEDGER_DEEPWATER_MCP_URL_UNSET`,
  `LEDGER_DEEPWATER_CATALOG_UNAVAILABLE`) rather than persisting a dead
  toggle. Everything else — default OFF with explicit per-agent
  `requiresExplicitGrant` grants, the exact six-entry launcher bundle and
  `/api/integrations/products/deep-water/agent-access`, the team-lock →
  policy-lock → 6/6-read → run-insert ordering, handoff enforcement via
  server-authored `integrationLaunch` metadata with the
  ambiguity-is-fatal-never-terminal recovery matrix, the
  no-cost/no-currency rule, identity headers, and the managed-instance
  lifecycle (`MCP_INSTANCE_MANAGED_BY_INTEGRATION`,
  `LEDGER_DEEPWATER_ACTIVE_RUNS`) — is stated **in full** in `AGENTS.md` →
  the DeepWater bullet; read it before touching any of this.
  `deep_water_run_update` is **not** PA-only: any granted agent may write back
  the durable run record (same team + thread). Also:
  [docs/external-tool-integration.md](docs/external-tool-integration.md).

Customer tariffs, statements, credits, top-ups, subscriptions, adjustments,
and Stripe lifecycle stay in UOA; Nessie renders UOA-authored display models
only and stores no commercial state. `/tokens` is the customer Credits &
Billing surface; Nessie's owner-only local token/pricing/estimate/projection/
connector/file/budget telemetry is isolated at `/ops/usage`, and the two never
render together. The full contract — `UOA_BILLING_APP_KEY_NESSIE` + the
45-second actor assertion, the vendored
`@unlikeotherai/billing-statement-protocol` package with its SHA-256 lint
gate, frozen-action relaying, Statement V2, the billing-manager vs member
projections, and the login-time direct-access confirmation — is stated in
full in `AGENTS.md` (the customer-billing bullet); never restate or fork any
of it locally.

Builtin `web_search` is also Ledger-only
(`${LEDGER_PUBLIC_URL}/v1/serper/search` with `LEDGER_PROXY_TOKEN` + signed
identity); direct `google.serper.dev` calls and `SERPER_API_KEY` fallbacks are
forbidden — full rule in `AGENTS.md`.

Outbound egress to any caller-, operator- or model-supplied address goes
through `@nessie/runtime` `safeFetch` (or `pinnedFetch` where the caller
handles redirects itself), never `assertSafeUrl` + plain `fetch` — full rule,
caller list, and the DNS-rebinding rationale in `AGENTS.md` → "Outbound egress
is IP-pinned"; see also
[docs/security-audit-2026-06.md](docs/security-audit-2026-06.md). User-authored
MCP connectors are HTTP/SSE remote endpoints only (no stdio), and deep.agent
crawl scanning stays behind the MCP connector path — both rules in `AGENTS.md`.

> **Legacy JSON-RPC MCP server removed.** The old `GET /mcp` / `POST /mcp`
> JSON-RPC server lived only in the legacy `src/` tree, which is being
> deleted. There is no JSON-RPC `/mcp` endpoint on the live `api/` server.

See [docs/functionality.md](docs/functionality.md) for the authoritative API surface description. Section §7 describes the removed legacy MCP server for historical reference.

## Provider-linked calls + ringing

Calls are provider links, never an embedded Jitsi media surface: an owner or
admin selects each target team's Google Meet, Jitsi, or (when configured)
Microsoft Teams provider in `/settings/organization`; the caller popup links
its provider label there for that same audience. A channel call creates that
link then rings each invitee. Realtime publishes one
message per audience — one channel update and separate user-scoped incoming
rings — because combined scopes leak/replay incorrectly. Native push carries
only an internal call path/id, never an external meeting URI; the client loads
the call before opening the provider link. Browser Accept is a real anchor (or
a synchronous user gesture in a shell), never an asynchronous `window.open`.
`meeting_link_create` and `call_start` are PA-only builtins: they re-read the
acting member and call the same `@nessie/workspace-admin` functions as the
routes; `call_start` resolves membership from its target channel's organisation
and stamps `Call.createdViaAgentId`.

## Personal assistant — workspace provisioning

Five PA-only builtins (`personalAssistantOnly: true`,
`worker/src/run/pa-tools/provisioning.ts`), each mirroring one REST route's
authorization — no weaker, no stronger — and calling the same service
function the route calls. The pattern, the shared `@nessie/workspace-admin`
package, visible-refusal for owner-gated tools, and the
tool-ships-with-its-resolving-read rule are stated in `AGENTS.md` (the
PA-tool bullet). Per-tool facts:

- `agent_list` → `listAgentsForUser` (`safe: true`, read-only). Any active
  member, matching `GET /api/agents`, and scoped by the same entitlement the
  Agents page uses: an owner reaches every workspace-visible non-system agent
  including unbound ones plus private agents they own; everybody else reaches
  a workspace-visible agent through a channel they can see it working in —
  never narrowed by the session's project/team. It exists because
  `agent_bind_channel` and `agent_trigger_create` take an `agentId` and an
  owner picks that from a list when clicking; without it the assistant could
  only act on an agent created in the same conversation. Output is the acting
  shape only — name, role, `agentId`, and the channels it is bound to — with an
  optional `query` narrowing the already-authorized list by name or role.
- `channel_create` → `createChannelForUser`. Any active member, matching
  `POST /api/channels` (only `requireActorContext`). The team defaults from the
  run context: explicit `teamId`, else the session tenant/action team, else the
  team of the channel the conversation is in — never an invented default.
- `agent_create` → `assertLedgerAgentModelSelection` + `createAgentRecord`. Any
  active member, matching `POST /api/agents` (**not** owner-gated). Its schema
  accepts optional `visibility` (`workspace` by default, or owner-only
  `private`) and deliberately exposes no `agentKind`/`systemManaged`/
  `surfacePolicy`/`delegationMode`/`parentAgentId`; private creation stamps the
  live acting member as owner and atomically provisions its owner-only home DM,
  returning that `homeChannelId`. Asking for somebody else's private agent is
  refused in words. `assertGenericAgentToolPolicyInput` still refuses
  every `requiresExplicitGrant` key and DeepWater provenance marker, so chat
  cannot grant itself research.
- `agent_bind_channel` → `bindAgentToChannel`. Reproduces all four gates of
  `POST /api/agents/:agentId/bindings`: channel membership
  (`getChannelIfMember`), the `personal_assistant` system-channel refusal,
  owner, and `checkPolicy(…, 'agent', 'bind', …)`.
- `agent_trigger_create` → `createAgentTrigger`, parsing the route's own
  `CreateAgentTriggerBodySchema`; scheduled/interval triggers build
  `launchOrigin` from the acting user and carry `actionContext.uoaIdentity`,
  and a signing deployment refuses a schedule without it — the same refusal
  `api/src/routes/triggers.ts` makes (it would fail at every sweep forever).

Owner-gated tools stay **visible** to non-owners and refuse in words (the
`connector_*` precedent): the assistant says who can do it, instead of claiming
it has no such capability. Role is re-read from the live `OrganizationMember`
row at call time (`resolveActingMember`), because a run's `actorContext` is a
snapshot from enqueue time while the API re-resolves the role per request; a
deactivated membership is refused. Deliberately **not** included: agent update,
agent delete, policy-target mutation, or anything touching the DeepWater bundle.
`schedule_task` remains the un-gated "schedule *me*" tool; `agent_trigger_create`
is the owner action on *another* agent.

Private-agent transfer is deliberately unsupported: the owner-only home DM
encodes the steward, so an `ownerUserId` change is refused with
`AGENT_PRIVATE_TRANSFER_UNSUPPORTED` until the agent is published. When a
private owner is deactivated, the owner-only Members surface receives only the
aggregate paused-agent count from `GET /api/agents/paused-private-count`; it
never receives private agent rows or names.

Private creation is one transaction: the agent, its
`agent:{org}:{owner}:{agent}` private DM, the sole owner membership, default
thread, and direct home binding either all commit or none do. Database
constraints independently refuse a second home member, a malformed `agent:` DM,
or a private-agent binding to any other channel. The worker re-checks the
loaded destination before inference and permits only that home DM or the
agent's own trigger thread. Owner deactivation disables only private-agent
triggers in the membership transaction, records one aggregate audit transition
with no widened recipient, and does not auto-resume on reactivation.

**Reuse, never fork.** `api/src/services/*` cannot be imported by the worker, so
the shared functions live in **`@nessie/workspace-admin`** (mirroring how
`@nessie/mcp-manage` is shared) and the api services re-export them, leaving the
routes untouched: channel create/records/slugs, agent create/list/record/
bindings and the tool-policy protected-key gate, trigger
create/core/config-identity, the
Ledger agent-model catalogue, `checkPolicy`, and the `getChannelIfMember` /
`isAgentAccessibleToActor` predicates. The records those functions return
(`ChannelRecord`, `AgentRecord`, `AgentTriggerRecord`, `CreateAgentTriggerBody`)
moved to `@nessie/schemas` for the same reason; `api/src/contracts` re-exports
them.

## Individual Communications Connector

Core rules (adapter registry wired only via `@nessie/comms-providers`
`registerCommsConnectorsFromEnv` from `NESSIE_COMMS_*` env at API + worker
startup, encrypted token bundles in a separate table, resumable checkpointed
sync through the worker queue, owner-deactivation revocation gate, no
reasoning logic in the connector layer): `AGENTS.md` (the comms bullet).
Additional facts:

- Adapter packages: `@nessie/comms-slack`, `@nessie/comms-google` (Slack +
  Gmail live; Microsoft/Teams planned), normalizing into the `CommsEvent`
  store via the provider-agnostic `@nessie/comms-connect` core. Env names
  match the API OAuth-start source of truth
  (`api/src/routes/comms/oauth-config.ts`).
- Prisma-aware credential loading lives in `@nessie/workspace-admin`, shared
  by API and worker: it decrypts only the selected connection, serializes
  expired token refresh under a credential-row lock, preserves a stored
  refresh token when Google omits a replacement, persists expiry/scope
  changes, and moves a provider-rejected credential atomically to
  `needs_reauthorization`. Do not recreate row-to-connector decryption in
  either process.
- An expired provider cursor (`SyncCursorExpiredError`) triggers a bounded
  history re-sync; a rejected credential (`needsReauthorization`) fails the
  job without retry. The owner-active gate lives in
  `worker/src/control/comms-sync.ts` (`isConnectionOwnerActive`).
- Chat-first: the `comms_connect_card` PA tool drives connect;
  `/settings/connections` is the secondary UI. Authoritative spec:
  [docs/plans/2026-07-21-individual-communications-connector.md](docs/plans/2026-07-21-individual-communications-connector.md).

### Google scopes are a capability catalog, and the checks fail closed

`packages/schemas/src/google-capabilities.ts` is the single source of truth for
which Google scopes Nessie may request, what each lets an agent do, and its
verification tier. Never hardcode a Google scope anywhere else, and never
derive a capability from a raw scope string at a call site. Plan and phasing:
[docs/plans/2026-08-31-google-workspace-email-calendar.md](docs/plans/2026-08-31-google-workspace-email-calendar.md).

- **`grantedScopes` is what Google returned, never what we asked for.** A
  person can un-tick individual scopes on the consent screen, so the token
  response is the only truthful account of the grant. `connect()` refuses a
  response carrying no `scope` rather than falling back to the request — the
  fallback that used to be there recorded authority the user had declined.
  *Refresh* keeps a fallback to the stored scopes, where an omitted `scope`
  genuinely means unchanged.
- **Identity comes from the OIDC `id_token`, never Gmail.**
  `users.getProfile` requires a Gmail read scope, so a calendar-only,
  send-only or Meet-only connection could not be established at all while
  identity came from it. `openid email profile` is requested on every connect
  for this reason; issuer, audience and expiry are validated, and Google's
  stable `sub` is stored as `CommsConnection.providerAccountId`.
- **403 is two different failures.** Google reuses it for rate limiting and for
  insufficient scope. Only the rate-limit reasons retry; `insufficientPermissions`
  is fatal and flagged `scopeMissing`, so a missing scope can surface as a
  request to grant it instead of looping until the job dies.
- **Capability checks are all-of, at the one chokepoint.**
  `loadUserGoogleCommsCredential` takes `requiredScopes` (every one must be
  granted — `contacts.read` needs two), enforces `disabledCapabilities`, and
  refuses `AMBIGUOUS_ACCOUNT` when two of a user's Google accounts qualify
  rather than silently taking the most recently updated one.
- **A local block is not a revocation.** Google's `/revoke` kills a whole
  grant, so removing one capability is a local gate enforced at the chokepoint;
  the UI says "blocked locally — Disconnect to revoke at Google" and must not
  claim otherwise.
- **OAuth state binds its target.** The state row carries the connection being
  widened, the expected provider account and the requested capabilities; the
  callback refuses `account_mismatch` when a different Google account completes
  consent, instead of silently re-pointing that mailbox. A first connect forces
  `prompt=consent` so Google issues a refresh token; an incremental add does
  not, and asks for the union of current and new scopes so a grant never
  narrows.

## MDNS

The backend registers `_nessie._tcp` on port 4317 via Bonjour/mDNS on launch. This feature is part of the legacy `src/` runtime; the new `api/` server does not yet register mDNS. Clients on the same network can discover the legacy server automatically without hardcoded IPs.

## Docs

- [brief.md](docs/brief.md) — Historical architecture brief (see banner)
- [build-ai-coworker.md](docs/done/build-ai-coworker.md) — Historical macOS app build plan (moved to done/)
- [context-window-optimization-audit.md](docs/context-window-optimization-audit.md) — Audit + prioritized roadmap for LLM context-window usage in the agentic run pipeline
- [known-limitations.md](docs/known-limitations.md) — Code-verified register of current limitations (status taxonomy; two fixes in flight as of 2026-07-23)
- Finished documents belong in `docs/done/`.

## Documentation & Goals — update with every change

Docs and stated goals stay in sync with the code in the same turn — part of
the definition of done, not a follow-up. Authoritative rule: `AGENTS.md` →
"Documentation & Goals".
