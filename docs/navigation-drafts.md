# Navigation — drafts

How the admin holds unsent state. It is chapter §15 of
[`navigation.md`](navigation.md), moved here so that file stays under the
markdown structure gate’s line cap; the rule it serves is stated there.


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
