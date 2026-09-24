# Document triggers — an edit to a project's documents wakes an agent to review it

Authoritative standard. `AGENTS.md` → "Architecture" carries the one-line
summary and points here; **this file is the rule.** The design is
[docs/plans/2026-09-23-ticket-driven-agents/triggers.md](../plans/2026-09-23-ticket-driven-agents/triggers.md)
→ "`document_changed`"; where that plan and the code differ, the code and this
file win, and each difference is listed under [Deviations](#deviations-from-the-plan).
Ticket work — the record, its thread, the `ticket.work` run — is
[ticket-work.md](ticket-work.md); this file says only how a document change
reaches it.

A person saves one of a project's documents. After a quiet window the agent a
`document_changed` trigger names is woken to review the change — in the
ticket's work thread when the document belongs to a ticket the same agent is
working, otherwise in the document's own review thread. The wake carries **no
document text**: the agent reads the change itself, through the same gates as
any read.

## What is shipped (T2)

Everything below is enforced in code: the typed configuration and its
server-side resolution, the version hook on every canonical writer, the quiet
window, the delivery and its routing, `kb_page_diff`, access lost as a health
stop, the Finder read, and the admin surfaces (the Triggers editor's document
fields, "Tell an agent when this changes…" in the Finder and project docs, and
the row badge).

## A document trigger's configuration is resolved on the server

- **The config is the `document_changed` arm of the typed union**
  (`DocumentChangedTriggerConfigSchema`, `packages/schemas/src/trigger-configs.ts`):
  `targetChannelId` beside a config of `spaceId?`, `folderPageId?`,
  `pageIds?` (1–50), `labels?` (1–20, any one matches, without case), `kinds`
  (`document` and/or `file`, default both — never `spreadsheet`), `fireOn`
  (`save` | `publish`, default `save`), `quietSeconds` (10–3600, default 180),
  `includeAgentEdits` (default false) and `instructions { general }`
  (required). It is strict, and every field is described, so the agent tools'
  enum and the Designer's catalogue are generated from it
  ([ticket-work.md](ticket-work.md) → "Nothing is half-exposed"). Taking
  `document_changed` off `UNRELEASED_TRIGGER_TYPES` released it; the list is
  empty now.
- **Resolution** (`resolveDocumentChangedTrigger`,
  `packages/team-admin/src/trigger-document-config.ts`) derives the project
  from the target channel, which must be live, ordinary and **public** with
  the agent bound — the check ticket triggers use, shared as
  `resolveTriggerTargetChannel` (`trigger-target-channel.ts`). The space is
  always stored by id: the one named, else the space of the folder or pages
  named, else the project's Documents space (`metadata.projectDocuments`); a
  space of another project is refused. `folderPageId` must be a folder of that
  space, each of `pageIds` a page of it of a watched kind. The stored config
  is `DocumentChangedStoredConfigSchema`'s shape (`folderPageId`, `pageIds`,
  `labels` null when absent), and the trigger's `scope_project_id` is the
  resolved project, which is how a save finds it; `scope_board_id` and
  `target_thread_id` stay null.
- **Three reads decide whether the agent may watch the space**, each refused
  on `spaceId`:
  - **the whole channel may read it** (`documentSpaceAudienceRefusal`): a
    project- or organisation-wide space, never private, channel- or team-only,
    restricted, private to an agent, or an agent's own home — every change is
    reviewed in that channel. "The whole channel" is read as ticket triggers
    read it: a public channel of the project is the project's audience, which
    is also how the disclosure model treats a reply there (a project channel
    implies its project and organisation scopes, `subtractImpliedScopes`). A
    team-only space is narrower than its project, so it is refused;
  - **the agent may read it**, with its own reach (`canReadSpace` over the
    agent's `SpaceViewer`): a document review runs with no effective user;
  - **the person setting it up may read it**, asked of their live entitlement
    (`resolveLiveEntitlements` with the request's UOA identity): nobody arms
    an agent on documents they could not open. A create with no person behind
    it is refused on `config`.
- **Refusals are field-level** (`TriggerConfigRefusalError`, the routes'
  400 `TRIGGER_CONFIG_REFUSED`), as for ticket triggers.
- **An edit names only what it changes** (`documentChangedConfigAsInput`,
  `mergeDocumentConfigPatch`): a key replaces, `instructions` merges one level
  deep, `null` clears a narrowing, and the whole is resolved again — the
  editor, when a person, asked the same read. **A resume resolves the stored
  config as a create would** (`documentTriggerResumeRefusal`), except for the
  author's own read; a trigger that stopped on a health failure is resumable
  once repaired (`resumeAgentTrigger` resolves it instead of asking for a
  fixed thread it never had — the same fix now holds ticket triggers).
- **No hand fire.** `POST /api/triggers/:id/fire` answers 409
  `DOCUMENT_TRIGGER_NOT_FIREABLE`: a review starts from a saved version.

## Every saved version is announced, inside the save

- **`onVersionCreated`** (`KnowledgeVersionCreatedEvent`,
  `packages/knowledge/src/version-events.ts`) is the one "a version exists
  now" signal: `createPage`, `updatePage`, `addFileVersion` and
  `restoreVersion` (`native-version-writer.ts`) each call
  `announceVersionCreated` after the version row and its disclosure, in the
  save's transaction, so a failed enqueue rolls the save back. It carries the
  page's own project, space and kind, and the version's number, author and
  origin. A `legacy_migration` version is never announced; a transfer copy
  (`transfer/copy.ts`) and the agent-core migration write their versions
  without the writer and announce nothing — neither is anybody editing a
  document. A folder has no versions. `onVersionChunksReplaced` is unchanged:
  it fires only when chunk rows were rewritten, which is not the same thing.
- **The consumer is `enqueueDocumentTriggerDispatch`**
  (`packages/team-admin/src/document-trigger-enqueue.ts`), wired as
  `documentTriggerOnVersionCreated` (fireOn `save`) and
  `documentTriggerOnPagePublished` (fireOn `publish`, reusing
  `onPagePublished`). It reads the enabled, active `document_changed`
  triggers by `scope_project_id` — a save no trigger watches costs one indexed
  read — and matches each on its space, kind, folder subtree, pages and labels
  (`documentTriggerWatchesPage`). A spreadsheet is never watched. Every save
  is enqueued, the agent's own included: whose saves wake the agent is the
  dispatcher's decision, and its own must still move the marker.
- **Wired by every process that writes documents:** the API's knowledge and
  transfer routes share one set of hooks (`apiKnowledgeProviderOptions`,
  `api/src/routes/knowledge-provider-options.ts`), the publish approval
  (`approval-effects.ts`), the worker's knowledge tools
  (`createWorkerKnowledgeProvider`) and the DeepWater report import. The
  spreadsheet provider, agent-core admission and task-set finalisation wire
  none: spreadsheets are excluded, and the other two write agent core and run
  output, not project documents.

## One quiet window, one review

- **The window is the queue's own delay.** The first save of a window
  enqueues `trigger.document.dispatch` (`TriggerDocumentDispatchJobPayloadSchema`:
  organisation, page, trigger — no version) with `delayMs = quietSeconds`
  and idempotency key `doc:<triggerId>:<pageId>:pending`
  (`documentTriggerPendingKey`); every later save in the window hits that key
  and adds nothing. `queue_jobs` keys are unique forever, so the handler's
  **first statement releases its key** (sets it null): a save committed after
  that opens the next window, and a save that lands between the release and
  the read is covered by this review and finds nothing new in the next.
- **When the job fires** (`dispatchDocumentChange`,
  `worker/src/control/document-trigger-dispatch.ts`) it reads the page's
  newest version (`fireOn: save`) or its published one (`publish`). The
  **marker** is the highest `toVersionNumber` among this trigger's deliveries
  for the page that moved it — delivered ones, and `agent_edits_only` skips
  (`loadMarker`); a skip for lost access, a page out of scope or a stopped
  ticket leaves the change owed, so the next review's diff still covers it.
  With no marker yet, the review starts from the page as it stood when the
  trigger was set up (`loadBaseline`), or from nothing for a page created
  since. Nothing after the marker: nothing happens.
- **Exactly one delivery per change**, deduped on
  `doc:<triggerId>:<pageId>:<toVersionId>` (`documentTriggerDeliveryKey`) on
  the existing `@@unique([triggerId, dedupeKey])`, with `source: document`
  and a `DocumentTriggerDeliveryPayloadSchema` payload: page, space, project,
  ticket, kind, fireOn, from and to version ids and numbers, how many
  versions were coalesced, the kinds of author that woke the agent, the body
  size, the outcome and its workId or threadId. **Metadata only**: no title,
  no text — the delivery log is read on the Triggers page, whose readers need
  not be able to read the document. A throw leaves a failed, retryable row;
  the delivery-retry poller decides the page again
  (`reattemptDocumentTriggerDelivery`), reusing the row only while the change
  is the same one.
- **Skips, each a delivery with its reason** (`DocumentTriggerSkipReasonSchema`,
  `DOCUMENT_TRIGGER_SKIP_SENTENCES`): `agent_edits_only`, `out_of_scope`
  (moved out of the folder, label removed, archived), `page_gone`,
  `access_lost`, `config_invalid`, `no_longer_applies`.

## The agent's own edits never wake it

Versions after the marker are counted by who saved them (`countVersions`):
the trigger's own agent's never count, so an agent reviewing a document and
editing it cannot loop; another agent's count only with `includeAgentEdits`,
and never an agent that itself has an enabled document trigger on the
project — two reviewers that both included agent edits would otherwise wake
each other forever.
A window of nothing but uncounted versions is skipped `agent_edits_only` and
moves the marker past them, so the next person's edit is diffed from the
agent's last version rather than re-showing its own changes.

## Where a change lands

In this order (`routeDocumentChange`, `document-trigger-route.ts`), inside the
delivery's transaction:

1. **The page's ticket's live work for this trigger's agent.** A ticket
   document (`KnowledgePage.taskId`) whose ticket has a live work record of
   **the same agent** wakes that record as a follow with reason
   `document_changed`, in its work thread, through the ticket work seam
   (`wakeTicketWork` with a precomputed event) — so the wake counts against
   `wakesPerTicket`, folds into a pending kickoff, and writes the thread's
   "Woken:" row like any follow. The ticket trigger's own rules hold: it must
   follow `document`, and a person who can edit the board must have saved
   part of the change — an agent's or a non-editor's edit never steers ticket
   work. Only that agent's record is woken, however many ticket triggers cover
   the board. The event carries the document trigger's own instructions.
   A ticket's state block promises document edits only while such a trigger
   exists for its agent (`documentsWatched`), worded as "one of its
   documents that your document trigger watches", since it may cover only some.
2. **Otherwise the page's own review thread**: one per (trigger, page) in the
   target channel (`ensureDocumentReviewThread`,
   `worker/src/control/document-trigger-run.ts`), a conversation with the
   trigger's agent opened by nobody, with metadata `{ pageId, triggerId }`
   (`DocumentTriggerThreadMetadataSchema`) — never the channel's General
   thread — titled `Review: <title>`, or by the page's id where the title may
   not be said. The run acts as the agent with no effective user and
   `interactive: false`, purpose `document_changed`, like every event
   trigger. Each wake writes a compact `document_woken` row
   (`TicketWorkThreadEventSchema`), which the thread feed shows as "Woken:".
   The agent's conversation list folds these threads under **Documents**, as
   it folds work threads under Tickets: the conversation record carries
   `document: { pageId }` from the thread's metadata
   (`documentReviewThreadRefOf`, `agent-conversation-tickets.ts`).
   A ticket's document lands here when that ticket's work is not live for the
   agent, does not follow documents, or was steered by nobody who may, and
   the kickoff names the ticket and says which. A ticket work wake the seam
   refuses (its wake limit, work that ended a moment ago) is reviewed here
   too, rather than lost.

## What a wake says

- **Metadata only** (`describeDocumentChange`, `renderDocumentReviewKickoff`,
  `document-trigger-kickoff.ts`): who saved it by kind ("a person", "2 people
  and another agent"), which versions, how many, how large, and the exact call
  that reads the change — `kb_page_diff(pageId, fromVersionId, toVersionId)`,
  or `kb_page_read(pageId, versionId)` for a page with nothing to diff
  against. Never a word of the document.
- **The page is named by its title only when every reader of the target
  channel may read it** (`pageNameableInChannel`): the space already is (it
  is checked on every fire), the page is project- or organisation-wide, not
  restricted or private to an agent, and the version carries no disclosure
  basis of its own. Otherwise it is named by id, and the review thread too.
- A change any part of which a person who cannot edit the board, or another
  agent, saved is framed as third-party content: information, never an
  instruction, never forwarded to a coding agent as one.

## Reading the change: `kb_page_diff`

`kb_page_diff(pageId, fromVersionId, toVersionId)`
(`worker/src/run/pa-tools/knowledge-diff.ts`, a safe builtin enabled like
`kb_page_read`) passes exactly `kb_page_read`'s gates — now one module,
`knowledge-page-gate.ts` — for the page **and for each version**: the space
readable by the caller, no restricted page and no page private to another
agent for an agent, each version this page's and passing its own disclosure
basis. Both versions are recorded in the run's consumed-source sink before a
word of either is read, because a diff discloses both sides. The answer is
unified hunks from the shared line diff (`computeLineDiff`,
`renderLineDiffHunks`, `packages/schemas/src/line-diff.ts`, which the admin's
review panel uses too), cut at 12 000 characters with a note naming the
`kb_page_read` call that reads the rest.

## Access lost pauses the trigger, loudly

At every fire the dispatcher asks again whether the agent can read the page
and its space, and whether the space is still as wide as the channel. If not,
the change is skipped `access_lost` **and the trigger is switched off with
health reason `document_trigger_access_lost`** (`recordTriggerHealthFailure`:
status `error`, one health alert), never skipped in silence; its owner fixes
access and resumes it. A config that no longer parses stops it with
`document_trigger_config_invalid`. A target channel that lost the agent or
went non-public throws the classified `agent_channel_access_lost`, as a
ticket trigger's does.

## What a person sees

- **The Finder read** `GET /api/knowledge-base/spaces/:spaceId/document-triggers?pageIds=…`
  (`api/src/routes/knowledge-document-triggers.ts`, `loadDocumentReviews`),
  behind the space's own read rule and each page's disclosure, never the
  owner-only Triggers routes: for each listed page the viewer may read, the
  newest delivered review (`DocumentReviewRecordSchema`: agent, version,
  when), the agent named only when the viewer may see it and the thread only
  when the viewer may open it; and `viewerCanCreateTriggers`, the Triggers
  routes' own owner gate.
- **The Triggers editor** offers "Document change" for an agent target only
  (`TriggerTypePicker agentTarget`). Its fields (`DocumentTriggerFields`,
  `document-trigger-form.ts`) offer only public project channels and say why,
  the channel's project's spaces — a space no public channel may watch shown
  but disabled (`spaceNarrowerThanChannel`, the server's audience rule as far
  as a space record shows it) — its folders and pages by path, labels, kinds,
  save or publish, the agent-edits opt-in and its loop guarantee, the quiet
  window in words ("5 min after the first save"), and the instructions. It
  posts the typed config by id (an edit sends `null` for a narrowing it
  removed), and a refusal lands on the field its path names
  (`groupDocumentRefusals`, on the shared `groupTriggerRefusals`). A document
  trigger's page names its space, folder and labels
  (`document-trigger-facts.ts`) and says what each delivery decided
  (`documentDeliveryLine`: the skip sentence, "reviewed in the document's
  thread", "woke the ticket's work"). There is no "Run now"
  (`canRunTriggerNow`), and its health reasons read as sentences
  (`TRIGGER_HEALTH_COPY`).
- **The Finder, and so a project's Docs tab**: "Tell an agent when this
  changes…" on a folder, document or file — never a spreadsheet, never a
  virtual row, never in a space no public channel may watch, and only when
  the Finder read says `viewerCanCreateTriggers` — opens the Triggers editor
  on a document trigger for that folder or page, type and target kind fixed,
  on a draft of its own (`FinderDocumentTrigger.tsx`, the pattern
  `BoardStartWorkDialog` set). A reviewed row carries *"Reviewed by CTO · v5"*
  (`DocumentReviewBadge`), from one read per listed folder
  (`useFolderDocumentReviews`), never per row. The row is itself a button, so
  the badge is not a nested link: a click on it opens the review thread, and
  the row's menu offers "Open review thread" for the keyboard; without a
  thread the viewer may open, the badge is text.

## Deviations from the plan

- **Only `KnowledgePage.taskId` links a page to a ticket.** The plan's "or a
  live work record that links the page" has no counterpart: a work record
  names no pages. Route 1 reads the page's `taskId`.
- **Route 1 keeps the ticket trigger's follow rules**: the ticket trigger must
  follow `document`, and a board editor must have saved part of the change.
  Otherwise the change goes to the page's own thread, with the reason, rather
  than being dropped.
- **The space is always resolved and stored**, `spaceId?` in the input only:
  the three reads need a concrete space.
- **The first review of a page diffs from the page as it stood when the
  trigger was set up** (`loadBaseline`), not from nothing.
- **The window key is released by the handler**: `queue_jobs` idempotency keys
  are unique forever, so `doc:<triggerId>:<pageId>:pending` would otherwise
  admit one window per page ever.
- **A document review is `interactive: false` with purpose `document_changed`**
  and writes a `document_woken` row; its run carries the document trigger's
  `triggerId`. A route-1 wake's run carries the **ticket** trigger's id (its
  limits and instructions are the ticket's) and the document trigger's
  delivery id.

## Tests that hold these rules

- `packages/schemas/src/__tests__/document-triggers.test.ts`,
  `trigger-configs.test.ts` and `line-diff.test.ts`: the arm's defaults and
  refusals, the scope matcher, the keys, a metadata-only payload, hunks and
  their bound.
- `packages/knowledge/test/version-events-db.test.ts`: every writer announces
  its version; a folder, a metadata-only edit, a `legacy_migration` version
  and a transfer copy announce none.
- `packages/team-admin/test/trigger-document-config-db.test.ts`: resolution
  (Documents space, folder-implied space, one-key edit), every field-level
  refusal (a private channel, another project's space, a private or
  restricted space, a non-folder, a foreign page, a kind mismatch, missing
  instructions, a thread or schedule, an author who cannot read the space, no
  author), the resume refusal, and the quiet window opened once per window,
  never by a paused trigger, a publish trigger on save, or a page outside the
  folder. `trigger-type-availability.test.ts`: every type released.
- `worker/test/db/document-trigger.test.ts`: coalescing into one review in the
  page's own thread with no document text, the key released for the next
  window and its diff from the marker, the agent's own and other agents'
  saves (and, with `includeAgentEdits`, another agent's, never a fellow
  reviewer's), a ticket's document routed to its live work, a ticket document with
  no live work reviewed in its own thread naming the ticket, a board with two
  ticket triggers waking only the same agent's record, and access lost
  pausing the trigger with a health reason and one alert.
  `worker/test/db/knowledge-diff.test.ts`: hunks, both versions recorded, the
  gates for the page and each version, and the 12 000-character cut.
- `api/test/knowledge-document-triggers-routes.test.ts`: the Finder read's
  newest review per readable page, a thread linked only for its readers, the
  owner-only doorway, a space the viewer cannot read refused.
- `admin/test/document-trigger-form.test.ts`: the form posts exactly what
  `DocumentChangedTriggerConfigSchema` parses (an edit merged as the server
  merges it), a refusal lands on its field, only public project channels and
  channel-wide spaces are offered, the delivery lines.
  `admin/test/document-review-badge.test.tsx`: the badge with and without a
  thread, and the `document_woken` "Woken:" row.
  `admin/test/finder-menu.test.ts`: the doorway only for
  `viewerCanCreateTriggers`, never on a spreadsheet or a virtual row.
  `admin/test/trigger-type-unreleased.test.tsx`: both agent-only types offered
  for an agent only, never run by hand, edited as typed configs.
- `pnpm --filter @nessie/admin test:e2e:agent-triggers` (see `CLAUDE.md`):
  the document form, a refusal on the space field, the typed create, the
  trigger's page, and in a project's Docs tab the badges, the menu and the
  prefilled doorway — at 1280 and 390 px.
