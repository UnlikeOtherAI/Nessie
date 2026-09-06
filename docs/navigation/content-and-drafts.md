# Arriving with content, and drafts

Chapter of [Navigation — how it is done](overview.md). §14–§15: prewarm,
previous data and the one skeleton that make a screen arrive with content, and
the draft rules that keep a half-written thing from being lost to a Back.

## 14. Arriving with content — **built** (step 10)

The stack slides for 300 ms; the destination has to have something to show
for it. Four pieces, plus one cache underneath them all.

- **Prewarm on intent** — `admin/src/navigation/prewarm.ts`. `usePrewarm()`
  returns `prewarm(to)`; `prewarmRowHandlers(prewarm, to)` is what a row
  spreads onto its element, firing on `pointerdown`, `touchstart` and `focus`
  — all *before* the click, so the destination's first query is in flight
  before the slide starts. The registry is six entries, keyed by destination
  path: `/channels/:id` → that channel's first messages page (its thread id
  read out of the already-cached channel list), `/projects/:id` (and its six
  section routes) → the board, `/agents/:id` → the agent's status,
  `/dashboards/:id` → the dashboard, `/knowledge-base/spaces/:id` → the space
  and its pages, `/apps/:slug` → the app. Each entry calls the **exact
  `fetch*` function the destination's hook calls**, under the exact key from
  `lib/query-keys.ts` — a URL spelled here would be a second fetcher, and the
  first divergence would fill the cache under the right key with the wrong
  shape (pinned: `prewarm.ts` contains no `/api/` literal). No hover storms:
  a per-hook TTL map (`PREWARM_TTL_MS`, 10 s) makes a focus/pointerdown/touch
  burst one request, and `prefetchQuery` honours the same `staleTime` so a
  warm entry costs nothing. Wired to the sidebar channel/DM/project/starred
  rows, the knowledge space list, the agents table, the app cards and the
  dashboards list.
- **Sibling swaps keep previous data.** Every facade `useQuery` that is keyed
  by an entity id, or gated on one (`enabled: Boolean(id)`), passes
  `placeholderData: keepPreviousData`, so channel A → B shows A's feed until
  B's arrives instead of flashing empty. Pinned by
  `admin/test/skeleton.test.ts`; the exemptions are billing, whose keys are
  scoped per UOA org/team and must never reuse another team's projection, and
  connected mail/Gmail drafts, where a mailbox, thread or provider draft is
  private third-party content and must never briefly paint under a new account,
  provider or entitlement identity.
  The corollary is that **`isSuccess` no longer means "this entity's data"** —
  a query serving placeholder data reports success — so a consumer that acts
  on identity guards with the id: the thread read marker refuses while its
  messages are placeholders (`isConversationReadReady`'s
  `messagesArePlaceholder`, or it would advance the new thread's cursor to a
  message it never held), and the dashboard editor seeds its draft layout only
  from `dashboard.id === dashboardId`.
- **Pending is never "empty".** The three lists that asserted "nothing here
  yet" while still loading now render the skeleton: the knowledge space list
  (both its sidebar and the project Documents tab), the triggers column, and
  the workflows column. Each takes the fact from its own query, and a *disabled*
  query — the non-owner case, whose refusal is the page's own gate — is
  deliberately not "loading".
- **One `Skeleton`, four page types** —
  `admin/src/components/primitives/Skeleton.tsx`: `list`, `detail`, `feed`,
  `board`, plus `SkeletonBlock` for the placeholders that are one sized
  rectangle (a dashboard tile holding its grid cell open, a pill standing in
  for a count). A screen picks the variant its content is shaped like, so the
  reveal lands on a plausible shell. It replaced three systems on two
  different tokens (`AppSkeletons`, `SectionSkeleton`, the agents/sessions
  table rows, the dashboard rectangle); `admin/test/skeleton.test.ts` pins
  that no other file under `admin/src` declares `animate-pulse` markup, with
  two allowed exceptions that pulse a live status rather than a placeholder.
- **One blob cache** — `admin/src/lib/blob-cache.ts`, behind
  `useAuthedObjectUrl` / `useAuthedObjectUrlFromPath`. An authed image cannot
  be a plain `<img src>`, so every avatar, app icon and attachment preview was
  fetched and decoded again on *every mount*. The cache is a bounded LRU
  (96 entries) of object URLs keyed by request path plus the caller's pinned
  MIME, reference-counted: an entry is revoked only when evicted, and only an
  entry nobody holds may be evicted — a `blob:` URL dropped without revoking
  leaks for the life of the tab, and one revoked under a live `<img>` renders
  as a broken image. A hit is read during render (`peekBlobUrl`), so a
  retained or re-entered screen paints its faces on the first frame; the
  resolved URL carries the key it belongs to, so a path change reads as a miss
  on that same render rather than one effect later. It is deliberately **not**
  keyed by token — the bytes stay valid across the 30-minute rotation that
  used to re-fetch every image on screen — and it is cleared with the query
  cache when the session ends.

## 15. Drafts — **built** (step 12)

Nothing in the admin asks a person "discard changes?" about their own draft.
Leaving a screen is safe because the draft is already persisted. One
primitive, `admin/src/navigation/useDraft.ts`, is the only way a surface holds
unsent state.

```ts
const { draft, setDraft, flush, clear, restored, revision, saveError, isSaving } =
  useDraft<T>(key, {
    initial,                                  // the baseline; equal to it = nothing to store
    local: { debounceMs: 300 },               // localStorage buffer (default 300 ms)
    server: { debounceMs: 2000, save },       // where an endpoint exists (default 2 s)
    isEmpty,                                  // optional: what "nothing to store" means
    revive,                                   // optional: storage is untrusted input
  })
```

- **Key scheme — `draft:<surface>:<entityId>`** (`draftKey(surface, entityId)`;
  a null entity means no store, so the surface keeps its state in memory only).
  The key is the **entity**, never the screen, which is what fixes the
  reset-on-channel-change leak: a composer draft is per channel, a reply draft
  per root message, a task draft per task, an editor draft per page.

  | surface | key |
  | --- | --- |
  | channel and DM composers, both info drawers | `draft:composer:<channelId>` |
  | reply-thread composer (panel + Threads inbox) | `draft:reply:<rootMessageId>` |
  | message inline edit | `draft:message-edit:<messageId>` |
  | task dialog | `draft:task:<taskId \| new>` |
  | agent designer | `draft:agent-designer:<agentId \| new>` |
  | knowledge page editor | `draft:kb-page:<pageId \| new>` |
  | trigger editor | `draft:trigger:<triggerId \| new>` |
  | dashboard edit mode | `draft:dashboard-layout:<dashboardId>` |
  | workflow designer (pre-existing, its own store) | `nessie.workflow-designer.draft.<templateId \| new>` |

- **Two lanes, a signature diff, and no retry loop.** The local lane buffers on
  a short debounce; the server lane flushes on a longer one. Both compare a
  signature, so a re-render that changes nothing touches neither storage nor
  the network. A payload the server **rejected** is remembered and never
  re-sent by the auto lane — only an explicit `flush()` retries it — and the
  rejection surfaces as `saveError` on the returned state, never a blocking
  dialog. Every storage access is guarded (private mode, quota, site data
  blocked), and a store that throws degrades to an in-memory draft.
- **A key change persists the outgoing draft under its own key first**, then
  reads the new one — the synchronous ordering is exactly what stops one
  channel's text and staged attachments arriving in the next. `revision` bumps
  only when the hook itself replaced the value (key swap, restore, `clear()`),
  which is how the uncontrolled composer repaints itself without a keystroke
  re-rendering its own text back into it.
- **Composer drafts carry staged attachment *metadata*, never bytes**
  (`components/features/channels/composer-draft.ts`): only a finished upload
  (`status === 'done'` with an `attachmentId`) is stored, because its bytes
  already live server-side. A draft whose text trips the structural
  `detectSecrets` scanner counts as empty and is deleted rather than written —
  the composer already refuses to send a credential, and the disk is the one
  place that refusal must also hold.
- **Save buttons go where a server flush is possible.** Three surfaces keep
  their primary action deliberately, each for a stated reason: a **create**
  form cannot flush before its required fields are valid (the task dialog, a
  new agent, a new page — leaving keeps the local draft); the **knowledge page
  editor** and the **dashboard** each append a durable version per save, so a
  debounced flush would bury the history their version panels exist for; and
  the **trigger editor** decides when automation fires, so re-arming a live
  schedule on every keystroke is not a save. All four still buffer locally, so
  nothing is lost.
- **A draft is written from a person's edit, never from a mount effect.** The
  agent designer mirrors its reducer into the draft and once did so on mount,
  while the reducer still held the empty baseline: that write counted as
  "nothing to store" and deleted the draft the person had come back for. The
  mirror now skips an untouched form (decided by comparison against the
  baseline, not a first-run flag — StrictMode re-runs effects with refs
  intact, so a flag armed on the first pass let the second pass wipe it), and
  starts once the form is edited or a stored draft has been restored. Pinned
  by `admin/test/agent-designer-draft-restore.test.ts`, which fails without
  the guard.
- **Message inline edit closes without discarding**: Escape leaves the editor,
  the rewrite stays under the message's key, and only a successful save clears
  it.
- **The one confirm that stays** is `useLeaveGuard`'s — an agent-authored
  document still streaming into a thread. That is not a person's draft.

### The API is safe to auto-save against

- **`POST /api/threads/:threadId/messages` takes a client idempotency key.**
  Body field `clientMessageId` (the `Idempotency-Key` request header is
  accepted as the transport spelling; the body field wins). It is stored on
  `Message.clientMessageId`, unique per thread
  (`messages_thread_id_client_message_id_key`; NULLs are distinct in
  PostgreSQL, so every message posted without one is unaffected). A retry
  carrying a key the thread already holds returns **200** with that message and
  no `pendingAgentInvites`, rather than the **201** of a fresh post — the
  attachments, alerts, push and orchestration of the first attempt are not
  replayed. Two attempts racing past the pre-check are resolved by the unique
  index and the loser replays the winner. The admin composers mint one key per
  unsent draft, keep it while the attempt is unresolved, and mint a fresh one
  after a success or a channel switch.
- **`If-Match` on the conditional writes.** `PUT /api/dashboards/:id/layout`
  (`Dashboard.revision`), `PUT /api/workflows/:workflowTemplateId`
  (`WorkflowTemplate.version`) and `PATCH /api/knowledge-base/pages/:pageId`
  (`KnowledgePage.revision`, added in migration
  `20260902130000_knowledge_page_revision`) accept the revision the caller
  edited — bare, quoted, or weak — and answer **409** with
  `details.currentRevision` when it is not the current one
  (`DASHBOARD_REVISION_CONFLICT`, `WORKFLOW_TEMPLATE_VERSION_CONFLICT`,
  `KNOWLEDGE_PAGE_REVISION_CONFLICT`). A header the server cannot parse is a
  **400 `INVALID_IF_MATCH`**, never a silent unconditional save; a missing
  header or `*` means "no opinion" and saves unconditionally, which is what
  makes it the "keep mine" answer. The one parser is
  `api/src/lib/if-match.ts`.
- **A conflict is a choice in place, never a dialog.** The dashboard renders a
  bar over the grid and the workflow designer replaces Save in its header, both
  offering **Keep mine** (save again with no precondition) and **Take theirs**
  (drop this draft and rehydrate). The draft survives either way.

Pinned by `admin/test/use-draft.test.ts` (restore, debounce, key-change
isolation, signature diff, a rejection kept out of the retry loop, `clear`, a
throwing store), `admin/test/draft-surfaces.test.ts` (every adopted surface
calls `useDraft` with its entity key and carries no discard confirm),
`api/test/message-idempotency.test.ts`,
`api/test/if-match-conditional-writes.test.ts`, and
`packages/knowledge/test/page-revision-db.test.ts`.
